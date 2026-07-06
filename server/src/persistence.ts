/**
 * Capa de persistencia del Order Controller.
 *
 * Usa better-sqlite3 (sincrónico, embebido). La base vive junto al proceso Node
 * y se considera autoritativa: en caso de crash, el controller reconstruye
 * su estado desde aquí, consulta el hardware y reanuda.
 *
 * Esquema:
 *   controller_orders (orderId PK, tableId, commandId, state, sequence,
 *                      failureCode, reason, acceptedAt, dispatchedAt,
 *                      completedAt, servedAt, lastEventAt, retryCount,
 *                      envelope_json, hardwareSnapshot_json, fifoKey, groupId)
 *   controller_queue  (orderId PK, tableId, fifoKey, enqueuedAt, groupId)
 *   controller_hardware (id PK=1, snapshot_json, lastSeenAt)
 *   controller_meta   (key PK, value)
 *
 * La columna `state` se valida con CHECK; cualquier valor fuera del set
 * provoca error de SQLite, lo que es defensa en profundidad contra bugs.
 */

import Database from 'better-sqlite3';
import { dirname } from 'path';
import { mkdirSync } from 'fs';

import {
  compareFifoEntries,
  ControllerState,
  createInitialControllerState,
  HardwareSnapshot,
  ManagedOrder,
  QueueEntry,
  queueKey,
} from './ControllerState';
import { OrderEnvelope, OrderState } from '../../src/protocol/types';

const VALID_STATES: OrderState[] = [
  'queued',
  'dispatching',
  'accepted',
  'preparing',
  'ready',
  'served',
  'failed',
];

export interface ControllerPersistence {
  loadState(): ControllerState;
  saveOrder(order: ManagedOrder, queueEntry: QueueEntry | null): void;
  saveQueueEntry(entry: QueueEntry): void;
  removeQueueEntry(orderId: string): void;
  saveHardware(snapshot: HardwareSnapshot | null): void;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  /** Lista de orders conocidas, para diagnóstico. */
  listOrderIds(): string[];
  close(): void;
}

export function createSqlitePersistence(dbPath: string): ControllerPersistence {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS controller_orders (
      orderId TEXT PRIMARY KEY NOT NULL,
      tableId INTEGER NOT NULL,
      commandId TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (${VALID_STATES.map((s) => `'${s}'`).join(', ')})),
      sequence INTEGER NOT NULL,
      failureCode TEXT,
      reason TEXT,
      acceptedAt INTEGER,
      dispatchedAt INTEGER,
      completedAt INTEGER,
      servedAt INTEGER,
      lastEventAt INTEGER NOT NULL,
      retryCount INTEGER NOT NULL DEFAULT 0,
      envelope_json TEXT NOT NULL,
      hardwareSnapshot_json TEXT,
      fifoKey INTEGER,
      groupId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_state ON controller_orders(state);
    CREATE INDEX IF NOT EXISTS idx_orders_table ON controller_orders(tableId);

    CREATE TABLE IF NOT EXISTS controller_queue (
      orderId TEXT PRIMARY KEY NOT NULL,
      tableId INTEGER NOT NULL,
      fifoKey INTEGER NOT NULL,
      enqueuedAt INTEGER NOT NULL,
      groupId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_fifo ON controller_queue(fifoKey);

    CREATE TABLE IF NOT EXISTS controller_hardware (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot_json TEXT,
      lastSeenAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS controller_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  const upsertOrderStmt = db.prepare(`
    INSERT INTO controller_orders (
      orderId, tableId, commandId, state, sequence, failureCode, reason,
      acceptedAt, dispatchedAt, completedAt, servedAt, lastEventAt,
      retryCount, envelope_json, hardwareSnapshot_json, fifoKey, groupId
    ) VALUES (
      @orderId, @tableId, @commandId, @state, @sequence, @failureCode, @reason,
      @acceptedAt, @dispatchedAt, @completedAt, @servedAt, @lastEventAt,
      @retryCount, @envelope_json, @hardwareSnapshot_json, @fifoKey, @groupId
    )
    ON CONFLICT(orderId) DO UPDATE SET
      tableId = excluded.tableId,
      commandId = excluded.commandId,
      state = excluded.state,
      sequence = excluded.sequence,
      failureCode = excluded.failureCode,
      reason = excluded.reason,
      acceptedAt = excluded.acceptedAt,
      dispatchedAt = excluded.dispatchedAt,
      completedAt = excluded.completedAt,
      servedAt = excluded.servedAt,
      lastEventAt = excluded.lastEventAt,
      retryCount = excluded.retryCount,
      envelope_json = excluded.envelope_json,
      hardwareSnapshot_json = excluded.hardwareSnapshot_json,
      fifoKey = excluded.fifoKey,
      groupId = excluded.groupId
  `);

  const insertQueueStmt = db.prepare(`
    INSERT INTO controller_queue (orderId, tableId, fifoKey, enqueuedAt, groupId)
    VALUES (@orderId, @tableId, @fifoKey, @enqueuedAt, @groupId)
    ON CONFLICT(orderId) DO UPDATE SET
      fifoKey = excluded.fifoKey,
      enqueuedAt = excluded.enqueuedAt,
      groupId = excluded.groupId
  `);

  const deleteQueueStmt = db.prepare(`DELETE FROM controller_queue WHERE orderId = ?`);

  const upsertHardwareStmt = db.prepare(`
    INSERT INTO controller_hardware (id, snapshot_json, lastSeenAt)
      VALUES (1, @snapshot_json, @lastSeenAt)
    ON CONFLICT(id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      lastSeenAt = excluded.lastSeenAt
  `);

  const setMetaStmt = db.prepare(
    `INSERT INTO controller_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const getMetaStmt = db.prepare(`SELECT value FROM controller_meta WHERE key = ?`);

  function rowToManagedOrder(row: any): ManagedOrder {
    return {
      envelope: JSON.parse(row.envelope_json) as OrderEnvelope,
      state: row.state as OrderState,
      sequence: row.sequence,
      failureCode: row.failureCode ?? undefined,
      reason: row.reason ?? undefined,
      acceptedAt: row.acceptedAt ?? undefined,
      dispatchedAt: row.dispatchedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      servedAt: row.servedAt ?? undefined,
      lastEventAt: row.lastEventAt,
      retryCount: row.retryCount,
      hardwareSnapshot: row.hardwareSnapshot_json
        ? JSON.parse(row.hardwareSnapshot_json)
        : undefined,
    };
  }

  function rowToQueueEntry(row: any): QueueEntry {
    return {
      orderId: row.orderId,
      tableId: row.tableId,
      commandId: '',
      fifoKey: row.fifoKey,
      enqueuedAt: row.enqueuedAt,
      groupId: row.groupId ?? undefined,
      state: 'queued',
    };
  }

  return {
    loadState(): ControllerState {
      const state = createInitialControllerState();
      const orderRows = db
        .prepare(`SELECT * FROM controller_orders ORDER BY sequence ASC`)
        .all() as any[];
      for (const row of orderRows) {
        const order = rowToManagedOrder(row);
        state.orders.set(order.envelope.orderId, order);
        const maxSeq = state.nextSequenceByOrder.get(order.envelope.orderId) ?? 0;
        if (order.sequence > maxSeq) {
          state.nextSequenceByOrder.set(order.envelope.orderId, order.sequence);
        }
      }
      const queueRows = db
        .prepare(`SELECT * FROM controller_queue ORDER BY fifoKey ASC`)
        .all() as any[];
      for (const row of queueRows) {
        const entry = rowToQueueEntry(row);
        const order = state.orders.get(entry.orderId);
        if (!order) continue;
        if (order.state !== 'queued' && order.state !== 'dispatching') continue;
        entry.commandId = order.envelope.commandId;
        entry.state = order.state === 'dispatching' ? 'dispatching' : 'queued';
        state.queue.set(queueKey(entry.fifoKey, entry.orderId), entry);
        if (entry.fifoKey >= state.nextFifoKey) state.nextFifoKey = entry.fifoKey + 1;
      }
      const hwRow = db
        .prepare(`SELECT * FROM controller_hardware WHERE id = 1`)
        .get() as any;
      if (hwRow && hwRow.snapshot_json) {
        state.hardware = {
          ...(JSON.parse(hwRow.snapshot_json) as HardwareSnapshot),
          lastSeenAt: hwRow.lastSeenAt,
        };
      }
      return state;
    },
    saveOrder(order, queueEntry) {
      upsertOrderStmt.run({
        orderId: order.envelope.orderId,
        tableId: order.envelope.tableId,
        commandId: order.envelope.commandId,
        state: order.state,
        sequence: order.sequence,
        failureCode: order.failureCode ?? null,
        reason: order.reason ?? null,
        acceptedAt: order.acceptedAt ?? null,
        dispatchedAt: order.dispatchedAt ?? null,
        completedAt: order.completedAt ?? null,
        servedAt: order.servedAt ?? null,
        lastEventAt: order.lastEventAt,
        retryCount: order.retryCount,
        envelope_json: JSON.stringify(order.envelope),
        hardwareSnapshot_json: order.hardwareSnapshot
          ? JSON.stringify(order.hardwareSnapshot)
          : null,
        fifoKey: queueEntry?.fifoKey ?? null,
        groupId: queueEntry?.groupId ?? null,
      });
    },
    saveQueueEntry(entry) {
      insertQueueStmt.run({
        orderId: entry.orderId,
        tableId: entry.tableId,
        fifoKey: entry.fifoKey,
        enqueuedAt: entry.enqueuedAt,
        groupId: entry.groupId ?? null,
      });
    },
    removeQueueEntry(orderId) {
      deleteQueueStmt.run(orderId);
    },
    saveHardware(snapshot) {
      if (snapshot == null) {
        upsertHardwareStmt.run({ snapshot_json: null, lastSeenAt: null });
        return;
      }
      const { lastSeenAt: _drop, ...rest } = snapshot;
      upsertHardwareStmt.run({
        snapshot_json: JSON.stringify(rest),
        lastSeenAt: snapshot.lastSeenAt,
      });
    },
    setMeta(key, value) {
      setMetaStmt.run(key, value);
    },
    getMeta(key) {
      const row = getMetaStmt.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    listOrderIds() {
      const rows = db.prepare(`SELECT orderId FROM controller_orders`).all() as Array<{
        orderId: string;
      }>;
      return rows.map((r) => r.orderId);
    },
    close() {
      db.close();
    },
  };
}

/** Helper de testing: una persistence en memoria. */
export function createInMemoryPersistence(): ControllerPersistence {
  return createSqlitePersistence(':memory:');
}

export function snapshotQueue(state: ControllerState): QueueEntry[] {
  return [...state.queue.values()].sort(compareFifoEntries);
}
