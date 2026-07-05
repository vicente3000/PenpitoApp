import { create } from 'zustand';
import { ConnectionSnapshot } from '../adapters/ICommunicationAdapter';
import { MachineState } from '../models';

interface AppState {
  machineState: MachineState;
  isConnected: boolean;
  connectionSnapshot: ConnectionSnapshot;
  setMachineState: (state: MachineState) => void;
  setIsConnected: (connected: boolean) => void;
  setConnectionSnapshot: (snapshot: ConnectionSnapshot) => void;
}

export const useAppStore = create<AppState>((set) => ({
  machineState: {
    isOn: false,
    status: 'idle',
    currentRecipeId: undefined,
    requestedIceCount: 2,
    activeStepId: undefined,
    completedStepIds: [],
    skippedStepIds: [],
    isDrinkReady: false,
  },
  isConnected: false,
  connectionSnapshot: {
    broker: 'disconnected',
    deviceOnline: false,
    lastDeviceMessageAt: null,
    error: null,
  },
  setMachineState: (state) => set({ machineState: state }),
  setIsConnected: (connected) => set({ isConnected: connected }),
  setConnectionSnapshot: (snapshot) => set({
    connectionSnapshot: snapshot,
    isConnected: snapshot.broker === 'connected' && snapshot.deviceOnline,
  }),
}));

