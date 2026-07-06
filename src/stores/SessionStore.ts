import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { BillSplitMethod, SessionGuest, TableSession } from '../models';
import { deviceService } from '../services/DeviceService';
import { getDeviceId, getDeviceIdSync } from '../services/DeviceIdentityService';

const SESSION_STORAGE_KEY = 'penpito.table.sessions';

interface SessionState {
  sessions: TableSession[];
  deviceGuestName: string | null;
  deviceTableNumber: number | null;
  deviceId: string | null;
  loadSessions: () => Promise<void>;
  ensureTableSession: (tableNumber: number, qrValue: string) => TableSession;
  joinTable: (tableNumber: number, qrValue: string, guestName: string) => Promise<SessionGuest>;
  setSplitMethod: (tableNumber: number, method: BillSplitMethod, hostGuestId?: string) => void;
  setHostGuest: (tableNumber: number, guestId?: string) => void;
  setTipPercentage: (tableNumber: number, tipPercentage: number) => void;
  removeGuestFromTable: (tableNumber: number, guestId: string) => void;
  clearTableSession: (tableNumber: number) => void;
  changeGuestName: (tableNumber: number, guestId: string, newName: string) => void;
  requestBill: (tableNumber: number, requested: boolean) => void;
  syncSessionFromNetwork: (tableNumber: number, nextSession: TableSession) => void;
  setDeviceGuestName: (name: string | null) => Promise<void>;
  setDeviceTableNumber: (tableNumber: number | null) => Promise<void>;
  leaveCurrentTable: () => void;
}

function makeGuestId(tableNumber: number) {
  return `guest-${tableNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSession(tableNumber: number, qrValue: string): TableSession {
  return {
    table_number: tableNumber,
    qr_value: qrValue,
    guests: [],
    split_method: 'pay_own',
    host_guest_id: undefined,
    tip_percentage: 0,
  };
}

async function persistSessions(sessions: TableSession[]) {
  try {
    await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Session sync should never block the ordering flow.
  }
}

function publishSessionUpdate(tableNumber: number, sessions: TableSession[]) {
  const session = sessions.find((s) => s.table_number === tableNumber);
  if (session) {
    deviceService.publish(`penpito/table/${tableNumber}/session`, JSON.stringify(session));
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  deviceGuestName: null,
  deviceTableNumber: null,
  deviceId: null,
  loadSessions: async () => {
    try {
      const raw = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
      const guestName = await AsyncStorage.getItem('penpito.device.guestName');
      const tableNumberRaw = await AsyncStorage.getItem('penpito.device.tableNumber');
      const deviceId = await getDeviceId();
      
      const parsed = raw ? (JSON.parse(raw) as TableSession[]) : [];
      const sessions = Array.isArray(parsed) ? parsed : [];
      const deviceTableNumber = tableNumberRaw ? parseInt(tableNumberRaw, 10) : null;
      
      set({ sessions, deviceGuestName: guestName, deviceTableNumber, deviceId });
    } catch {
      // Invalid persisted data is ignored
    }
  },
  ensureTableSession: (tableNumber, qrValue) => {
    const existing = get().sessions.find((session) => session.table_number === tableNumber);
    if (existing) {
      return existing;
    }

    const nextSession = createSession(tableNumber, qrValue);
    const nextSessions = [...get().sessions, nextSession];
    set((state) => ({
      sessions: [...state.sessions, nextSession],
    }));
    void persistSessions(nextSessions);
    return nextSession;
  },
  joinTable: async (tableNumber, qrValue, guestName) => {
    const cleanName = guestName.trim();
    const deviceId = get().deviceId ?? (await getDeviceId());
    const currentSession = get().ensureTableSession(tableNumber, qrValue);

    const existingByDevice = currentSession.guests.find(
      (guest) => guest.device_id === deviceId
    );
    if (existingByDevice) {
      if (existingByDevice.name.trim().toLowerCase() !== cleanName.toLowerCase()) {
        get().changeGuestName(tableNumber, existingByDevice.id, cleanName);
      }
      return get().sessions
        .find((s) => s.table_number === tableNumber)
        ?.guests.find((g) => g.id === existingByDevice.id) ?? existingByDevice;
    }

    const existingByName = currentSession.guests.find(
      (guest) => guest.name.trim().toLowerCase() === cleanName.toLowerCase()
    );

    if (existingByName) {
      if (!existingByName.device_id) {
        const nextSessions = get().sessions.map((session) =>
          session.table_number === tableNumber
            ? {
                ...session,
                guests: session.guests.map((g) =>
                  g.id === existingByName.id ? { ...g, device_id: deviceId } : g
                ),
              }
            : session
        );
        set({ sessions: nextSessions });
        void persistSessions(nextSessions);
        publishSessionUpdate(tableNumber, nextSessions);
      }
      return existingByName;
    }

    const nextGuest: SessionGuest = {
      id: makeGuestId(tableNumber),
      name: cleanName,
      joined_at: Date.now(),
      device_id: deviceId,
    };

    const nextSessions = get().sessions.map((session) =>
        session.table_number === tableNumber
          ? { ...session, guests: [...session.guests, nextGuest] }
          : session
    );

    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);

    return nextGuest;
  },
  setSplitMethod: (tableNumber, method, hostGuestId) => {
    const nextSessions = get().sessions.map((session) =>
        session.table_number === tableNumber
          ? {
              ...session,
              split_method: method,
              host_guest_id:
                method === 'host_pays'
                  ? hostGuestId ?? session.host_guest_id
                  : undefined,
            }
          : session
    );
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);
  },
  setHostGuest: (tableNumber, guestId) => {
    const nextSessions = get().sessions.map((session) =>
        session.table_number === tableNumber
          ? { ...session, host_guest_id: guestId }
          : session
    );
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);
  },
  setTipPercentage: (tableNumber, tipPercentage) => {
    const normalizedTip = Math.max(0, Math.round(tipPercentage));
    const nextSessions = get().sessions.map((session) =>
        session.table_number === tableNumber
          ? { ...session, tip_percentage: normalizedTip }
          : session
    );
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);
  },
  removeGuestFromTable: (tableNumber, guestId) => {
    const nextSessions = get().sessions.map((session) => {
      if (session.table_number !== tableNumber) {
        return session;
      }

      return {
        ...session,
        guests: session.guests.filter((guest) => guest.id !== guestId),
        host_guest_id: session.host_guest_id === guestId ? undefined : session.host_guest_id,
      };
    });
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);
  },
  clearTableSession: (tableNumber) => {
    const nextSessions = get().sessions.filter((session) => session.table_number !== tableNumber);
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    // Para notificar que la mesa se cerró, enviamos una sesión vacía
    deviceService.publish(`penpito/table/${tableNumber}/session`, '{}');
  },
  changeGuestName: (tableNumber, guestId, newName) => {
    const cleanName = newName.trim();
    if (!cleanName) return;
    const nextSessions = get().sessions.map((session) => {
      if (session.table_number !== tableNumber) {
        return session;
      }
      return {
        ...session,
        guests: session.guests.map((g) => (g.id === guestId ? { ...g, name: cleanName } : g)),
      };
    });
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);
  },
  requestBill: (tableNumber, requested) => {
    const nextSessions = get().sessions.map((session) => {
      if (session.table_number !== tableNumber) {
        return session;
      }
      return {
        ...session,
        bill_requested: requested,
      };
    });
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
    publishSessionUpdate(tableNumber, nextSessions);
  },
  syncSessionFromNetwork: (tableNumber, nextSession) => {
    if (!nextSession || Object.keys(nextSession).length === 0) {
      const nextSessions = get().sessions.filter((s) => s.table_number !== tableNumber);
      set({ sessions: nextSessions });
      void persistSessions(nextSessions);
      return;
    }

    const deviceId = getDeviceIdSync();
    const localSession = get().sessions.find((s) => s.table_number === tableNumber);

    let mergedSession = nextSession;
    if (deviceId && localSession) {
      const localDeviceGuest = localSession.guests.find((g) => g.device_id === deviceId);
      const networkHasDevice = nextSession.guests.some((g) => g.device_id === deviceId);
      if (localDeviceGuest && !networkHasDevice) {
        mergedSession = {
          ...nextSession,
          guests: [...nextSession.guests, localDeviceGuest],
        };
      }
    }

    const hasSession = get().sessions.some((s) => s.table_number === tableNumber);
    let nextSessions: TableSession[];
    if (hasSession) {
      nextSessions = get().sessions.map((s) =>
        s.table_number === tableNumber ? mergedSession : s
      );
    } else {
      nextSessions = [...get().sessions, mergedSession];
    }
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
  },
  setDeviceGuestName: async (name) => {
    set({ deviceGuestName: name });
    if (name) {
      await AsyncStorage.setItem('penpito.device.guestName', name);
    } else {
      await AsyncStorage.removeItem('penpito.device.guestName');
      await get().setDeviceTableNumber(null);
    }
  },
  setDeviceTableNumber: async (tableNumber) => {
    set({ deviceTableNumber: tableNumber });
    if (tableNumber !== null) {
      await AsyncStorage.setItem('penpito.device.tableNumber', String(tableNumber));
    } else {
      await AsyncStorage.removeItem('penpito.device.tableNumber');
    }
  },
  leaveCurrentTable: () => {
    const { deviceGuestName: guestName, deviceTableNumber: tableNumber, sessions, deviceId } = get();
    if (!guestName || tableNumber === null) return;

    const session = sessions.find((s) => s.table_number === tableNumber);
    if (!session) return;

    const guestByDevice = deviceId
      ? session.guests.find((g) => g.device_id === deviceId)
      : undefined;
    const guest = guestByDevice ?? session.guests.find(
      (g) => g.name.trim().toLowerCase() === guestName.trim().toLowerCase()
    );
    if (!guest) return;

    get().removeGuestFromTable(tableNumber, guest.id);
  },
}));
