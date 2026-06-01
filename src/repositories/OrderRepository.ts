import { DrinkOrder, PreparationStepId } from '../models';
import { getDb } from './LocalDatabase';

type OrderRow = {
  id: string;
  recipe_id: string;
  recipe_name: string;
  table_number: number;
  qr_value: string;
  requested_at: number;
  status: string;
  ice_count: number;
  alcohol_oz: number | null;
  mixer_oz: number | null;
  piscola_intensity: string | null;
  est_time_seconds: number;
  active_step_id: string | null;
  completed_step_ids: string;
  skipped_step_ids: string;
  is_drink_ready: number;
  started_at: number | null;
  finished_at: number | null;
  served_at: number | null;
  queued_at: number | null;
  guest_name: string | null;
  group_id: string | null;
  split_method: string | null;
};

function parseStepIds(value: string): PreparationStepId[] {
  try {
    return JSON.parse(value) as PreparationStepId[];
  } catch {
    return [];
  }
}

function mapRow(row: OrderRow): DrinkOrder {
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    recipe_name: row.recipe_name,
    table_number: row.table_number,
    qr_value: row.qr_value,
    requested_at: row.requested_at,
    status: row.status as DrinkOrder['status'],
    ice_count: row.ice_count,
    alcohol_oz: row.alcohol_oz ?? undefined,
    mixer_oz: row.mixer_oz ?? undefined,
    piscola_intensity: (row.piscola_intensity as DrinkOrder['piscola_intensity']) ?? undefined,
    est_time_seconds: row.est_time_seconds,
    active_step_id: (row.active_step_id as PreparationStepId | null) ?? undefined,
    completed_step_ids: parseStepIds(row.completed_step_ids),
    skipped_step_ids: parseStepIds(row.skipped_step_ids),
    is_drink_ready: row.is_drink_ready === 1,
    started_at: row.started_at ?? undefined,
    finished_at: row.finished_at ?? undefined,
    served_at: row.served_at ?? undefined,
    queued_at: row.queued_at ?? undefined,
    guest_name: row.guest_name ?? undefined,
    group_id: row.group_id ?? undefined,
    split_method: (row.split_method as DrinkOrder['split_method']) ?? undefined,
  };
}

export class OrderRepository {
  async getAllOrders(): Promise<DrinkOrder[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<OrderRow>('SELECT * FROM orders ORDER BY requested_at DESC');
    return rows.map(mapRow).sort((a, b) => b.requested_at - a.requested_at);
  }

  async saveOrder(order: DrinkOrder): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO orders (
        id,
        recipe_id,
        recipe_name,
        table_number,
        qr_value,
        requested_at,
        status,
        ice_count,
        alcohol_oz,
        mixer_oz,
        piscola_intensity,
        est_time_seconds,
        active_step_id,
        completed_step_ids,
        skipped_step_ids,
        is_drink_ready,
        started_at,
        finished_at,
        served_at,
        queued_at,
        guest_name,
        group_id,
        split_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        order.recipe_id,
        order.recipe_name,
        order.table_number,
        order.qr_value,
        order.requested_at,
        order.status,
        order.ice_count,
        order.alcohol_oz ?? null,
        order.mixer_oz ?? null,
        order.piscola_intensity ?? null,
        order.est_time_seconds,
        order.active_step_id ?? null,
        JSON.stringify(order.completed_step_ids),
        JSON.stringify(order.skipped_step_ids),
        order.is_drink_ready ? 1 : 0,
        order.started_at ?? null,
        order.finished_at ?? null,
        order.served_at ?? null,
        order.queued_at ?? null,
        order.guest_name ?? null,
        order.group_id ?? null,
        order.split_method ?? null,
      ]
    );
  }

  async deleteOrdersForTable(tableNumber: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM orders WHERE table_number = ?', [tableNumber]);
  }

  async deleteOrder(orderId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM orders WHERE id = ?', [orderId]);
  }
}

export const orderRepository = new OrderRepository();
