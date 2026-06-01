import { BottleInventory } from '../models';
import { getDb } from './LocalDatabase';
import { mlToOz, ozToMl } from '../utils/drinkConfig';

type InventoryRow = BottleInventory & {
  capacity_oz?: number | null;
  remaining_oz?: number | null;
};

function normalizeBottle(row: InventoryRow): BottleInventory {
  return {
    id: row.id,
    ingredient_name: row.ingredient_name,
    display_name: row.display_name,
    capacity_ml:
      row.capacity_ml ?? (row.capacity_oz == null ? 0 : Math.round(ozToMl(row.capacity_oz))),
    remaining_ml:
      row.remaining_ml ?? (row.remaining_oz == null ? 0 : Math.round(ozToMl(row.remaining_oz))),
  };
}

export class InventoryRepository {
  async getAllBottles(): Promise<BottleInventory[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<InventoryRow>('SELECT * FROM inventory ORDER BY display_name');
    return rows.map(normalizeBottle);
  }

  async saveBottle(bottle: BottleInventory): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO inventory (
        id,
        ingredient_name,
        display_name,
        capacity_oz,
        remaining_oz,
        capacity_ml,
        remaining_ml
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        bottle.id,
        bottle.ingredient_name,
        bottle.display_name,
        Number(mlToOz(bottle.capacity_ml).toFixed(1)),
        Number(mlToOz(bottle.remaining_ml).toFixed(1)),
        Math.round(bottle.capacity_ml),
        Math.round(bottle.remaining_ml),
      ]
    );
  }

  async refillBottle(id: string): Promise<void> {
    const db = await getDb();
    const bottle = await db.getFirstAsync<BottleInventory>('SELECT * FROM inventory WHERE id = ?', [id]);
    if (!bottle) {
      return;
    }

    await this.saveBottle({
      ...bottle,
      remaining_ml: bottle.capacity_ml,
    });
  }

  async updateBottleCapacity(id: string, capacityMl: number): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<InventoryRow>('SELECT * FROM inventory WHERE id = ?', [id]);
    if (!row) {
      return;
    }

    const bottle = normalizeBottle(row);
    await this.saveBottle({
      ...bottle,
      capacity_ml: Math.round(capacityMl),
      remaining_ml: Math.round(Math.min(bottle.remaining_ml, capacityMl)),
    });
  }

  async consumeIngredients(usages: Array<{ ingredient_name: string; amount_ml: number }>): Promise<void> {
    const bottles = await this.getAllBottles();

    for (const usage of usages) {
      const bottle = bottles.find((entry) => entry.ingredient_name === usage.ingredient_name);
      if (!bottle) {
        continue;
      }

      await this.saveBottle({
        ...bottle,
        remaining_ml: Math.round(Math.max(0, bottle.remaining_ml - usage.amount_ml)),
      });
    }
  }

  async restoreIngredients(usages: Array<{ ingredient_name: string; amount_ml: number }>): Promise<void> {
    const bottles = await this.getAllBottles();

    for (const usage of usages) {
      const bottle = bottles.find((entry) => entry.ingredient_name === usage.ingredient_name);
      if (!bottle) {
        continue;
      }

      await this.saveBottle({
        ...bottle,
        remaining_ml: Math.round(Math.min(bottle.capacity_ml, bottle.remaining_ml + usage.amount_ml)),
      });
    }
  }
}

export const inventoryRepository = new InventoryRepository();
