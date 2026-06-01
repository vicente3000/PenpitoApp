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
      piscola_price: number;
      whisky_rocks_price: number;
      negroni_price: number;
      gin_tonic_price: number;
    }>('SELECT * FROM settings WHERE id = "default" LIMIT 1');

    if (!result) return null;

    return {
      bottle_capacity_ml: result.bottle_capacity_ml,
      dispense_speed_ml_s: result.dispense_speed_ml_s,
      ice_dispense_time_s: result.ice_dispense_time_s,
      auto_clean_enabled: result.auto_clean_enabled === 1,
      piscola_price: result.piscola_price,
      whisky_rocks_price: result.whisky_rocks_price,
      negroni_price: result.negroni_price,
      gin_tonic_price: result.gin_tonic_price,
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
        auto_clean_enabled,
        piscola_price,
        whisky_rocks_price,
        negroni_price,
        gin_tonic_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'default',
        settings.bottle_capacity_ml,
        settings.dispense_speed_ml_s,
        settings.ice_dispense_time_s,
        settings.auto_clean_enabled ? 1 : 0,
        settings.piscola_price,
        settings.whisky_rocks_price,
        settings.negroni_price,
        settings.gin_tonic_price,
      ]
    );
  }
}

export const settingsRepository = new SettingsRepository();
