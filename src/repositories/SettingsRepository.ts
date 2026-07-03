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
      pump_calibrations: string | null;
      carriage_positions: string | null;
    }>('SELECT * FROM settings WHERE id = "default" LIMIT 1');

    if (!result) return null;

    let calibs: number[] = [24.2, 23.1, 21.1, 24.0, 24.3, 15.9, 23.1];
    if (result.pump_calibrations) {
      try {
        calibs = JSON.parse(result.pump_calibrations);
      } catch (e) {
        console.error('Failed to parse pump calibrations', e);
      }
    }

    let positions: number[] = [3600, 2600, 800, 100, 1860, 1600, 1350, 1200];
    if (result.carriage_positions) {
      try {
        positions = JSON.parse(result.carriage_positions);
      } catch (e) {
        console.error('Failed to parse carriage positions', e);
      }
    }

    return {
      bottle_capacity_ml: result.bottle_capacity_ml,
      dispense_speed_ml_s: result.dispense_speed_ml_s,
      ice_dispense_time_s: result.ice_dispense_time_s,
      auto_clean_enabled: result.auto_clean_enabled === 1,
      pump_calibrations: calibs,
      carriage_positions: positions,
    };
  }

  async saveSettings(settings: MachineSettings): Promise<void> {
    const db = await getDb();
    const calibsStr = JSON.stringify(settings.pump_calibrations || [24.2, 23.1, 21.1, 24.0, 24.3, 15.9, 23.1]);
    const positionsStr = JSON.stringify(settings.carriage_positions || [3600, 2600, 800, 100, 1860, 1600, 1350, 1200]);
    await db.runAsync(
      `INSERT OR REPLACE INTO settings (
        id,
        bottle_capacity_ml,
        dispense_speed_ml_s,
        ice_dispense_time_s,
        auto_clean_enabled,
        pump_calibrations,
        carriage_positions
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'default',
        settings.bottle_capacity_ml,
        settings.dispense_speed_ml_s,
        settings.ice_dispense_time_s,
        settings.auto_clean_enabled ? 1 : 0,
        calibsStr,
        positionsStr,
      ]
    );
  }
}

export const settingsRepository = new SettingsRepository();
