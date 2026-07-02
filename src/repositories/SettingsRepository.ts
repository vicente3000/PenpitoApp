import { getDb } from './LocalDatabase';
import { MachineSettings } from '../models';

export class SettingsRepository {
  async getSettings(): Promise<MachineSettings | null> {
    const db = await getDb();
    const result = await db.getFirstAsync<{
      bottle_capacity_ml: number;
      dispense_speed_ml_s: number;
      ice_dispense_time_s: number;
      auto_clean_enabled: number;
    }>('SELECT * FROM settings WHERE id = "default" LIMIT 1');

    if (!result) return null;

    return {
      bottle_capacity_ml: result.bottle_capacity_ml,
      dispense_speed_ml_s: result.dispense_speed_ml_s,
      ice_dispense_time_s: result.ice_dispense_time_s,
      auto_clean_enabled: result.auto_clean_enabled === 1,
    };
  }

  async saveSettings(settings: MachineSettings): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO settings (
        id,
        bottle_capacity_ml,
        dispense_speed_ml_s,
        ice_dispense_time_s,
        auto_clean_enabled
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        'default',
        settings.bottle_capacity_ml,
        settings.dispense_speed_ml_s,
        settings.ice_dispense_time_s,
        settings.auto_clean_enabled ? 1 : 0,
      ]
    );
  }
}

export const settingsRepository = new SettingsRepository();
