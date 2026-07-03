import { create } from 'zustand';
import { MachineSettings } from '../models';
import { settingsRepository } from '../repositories/SettingsRepository';

interface SettingsState {
  settings: MachineSettings | null;
  isLoading: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (settings: MachineSettings) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  isLoading: false,
  error: null,
  loadSettings: async () => {
    set({ isLoading: true, error: null });
    try {
      let currentSettings = await settingsRepository.getSettings();
      if (!currentSettings) {
        // Default settings
        currentSettings = {
          bottle_capacity_ml: 1000,
          dispense_speed_ml_s: 15,
          ice_dispense_time_s: 2,
          auto_clean_enabled: true,
          pump_calibrations: [24.2, 23.1, 21.1, 24.0, 24.3, 15.9, 23.1],
          carriage_positions: [3600, 2600, 800, 100, 1860, 1600, 1350, 1200],
        };
        await settingsRepository.saveSettings(currentSettings);
      }
      set({ settings: currentSettings, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load settings', isLoading: false });
    }
  },
  updateSettings: async (settings: MachineSettings) => {
    try {
      await settingsRepository.saveSettings(settings);
      set({ settings });
    } catch (error) {
      set({ error: 'Failed to update settings' });
    }
  }
}));
