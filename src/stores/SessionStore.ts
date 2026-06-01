import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { BillSplitMethod, SessionGuest, TableSession } from '../models';

const SESSION_STORAGE_KEY = 'penpito.table.sessions';

interface SessionState {
  sessions: TableSession[];
  loadSessions: () => Promise<void>;
  ensureTableSession: (tableNumber: number, qrValue: string) => TableSession;
  joinTable: (tableNumber: number, qrValue: string, guestName: string) => SessionGuest;
  setSplitMethod: (tableNumber: number, method: BillSplitMethod, hostGuestId?: string) => void;
  setHostGuest: (tableNumber: number, guestId?: string) => void;
  setTipPercentage: (tableNumber: number, tipPercentage: number) => void;
  removeGuestFromTable: (tableNumber: number, guestId: string) => void;
  clearTableSession: (tableNumber: number) => void;
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

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  loadSessions: async () => {
    try {
      const raw = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as TableSession[];
      if (!Array.isArray(parsed)) {
        return;
      }

      set({ sessions: parsed });
    } catch {
      // Invalid persisted data is ignored and a fresh session can be created.
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
  joinTable: (tableNumber, qrValue, guestName) => {
    const cleanName = guestName.trim();
    const currentSession = get().ensureTableSession(tableNumber, qrValue);
    const existingGuest = currentSession.guests.find(
      (guest) => guest.name.trim().toLowerCase() === cleanName.toLowerCase()
    );

    if (existingGuest) {
      return existingGuest;
    }

    const nextGuest: SessionGuest = {
      id: makeGuestId(tableNumber),
      name: cleanName,
      joined_at: Date.now(),
    };

    const nextSessions = get().sessions.map((session) =>
        session.table_number === tableNumber
          ? { ...session, guests: [...session.guests, nextGuest] }
          : session
    );

    set({ sessions: nextSessions });
    void persistSessions(nextSessions);

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
  },
  setHostGuest: (tableNumber, guestId) => {
    const nextSessions = get().sessions.map((session) =>
        session.table_number === tableNumber
          ? { ...session, host_guest_id: guestId }
          : session
    );
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
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
  },
  clearTableSession: (tableNumber) => {
    const nextSessions = get().sessions.filter((session) => session.table_number !== tableNumber);
    set({ sessions: nextSessions });
    void persistSessions(nextSessions);
  },
}));
