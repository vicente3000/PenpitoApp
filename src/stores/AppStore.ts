import { create } from 'zustand';
import { MachineState } from '../models';

interface AppState {
  machineState: MachineState;
  isConnected: boolean;
  setMachineState: (state: MachineState) => void;
  setIsConnected: (connected: boolean) => void;
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
  setMachineState: (state) => set({ machineState: state }),
  setIsConnected: (connected) => set({ isConnected: connected }),
}));
