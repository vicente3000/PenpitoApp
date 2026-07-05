import * as SQLite from 'expo-sqlite';
import {
  DEFAULT_BOTTLE_CAPACITY_ML,
  ML_PER_OUNCE,
  ingredientCatalog,
  mlToOz,
} from '../utils/drinkConfig';

const DB_NAME = 'penpito.db';
const SCHEMA_VERSION = 7;
const DEFAULT_SETTINGS_ID = 'default';

type DbHandle = Awaited<ReturnType<typeof SQLite.openDatabaseAsync>>;

let dbPromise: Promise<DbHandle> | null = null;
let initPromise: Promise<void> | null = null;

const recipeSeedStatements = [
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
    VALUES (
      'piscola',
      'Piscola',
      'Pisco con Coca-Cola. Suave (45+165ml), Normal (60+180ml) o Fuerte (90+150ml). 4 hielos.',
      NULL,
      '[{"ingredient_name":"Pisco","amount_ml":90.0},{"ingredient_name":"Coca-Cola","amount_ml":150.0}]',
      28,
      14,
      1,
      7000
    )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
   VALUES (
      'negroni',
      'Negroni',
      'Clasico coctel de gin, campari y vermut rosso. 3 hielos.',
      NULL,
      '[{"ingredient_name":"Gin","amount_ml":75.0},{"ingredient_name":"Campari","amount_ml":75.0},{"ingredient_name":"Vermut Rosso","amount_ml":75.0}]',
      22,
      24,
      1,
      8000
    )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
   VALUES (
      'boulevardier',
      'Boulevardier',
      'Elegante variacion del Negroni usando Whisky. 3 hielos.',
      NULL,
      '[{"ingredient_name":"Whisky","amount_ml":75.0},{"ingredient_name":"Campari","amount_ml":75.0},{"ingredient_name":"Vermut Rosso","amount_ml":75.0}]',
      22,
      28,
      1,
      8500
    )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
   VALUES (
      'godfather',
      'Godfather',
      'Mezcla clasica de Whisky y Amaretto. 3 hielos.',
      NULL,
      '[{"ingredient_name":"Whisky","amount_ml":150.0},{"ingredient_name":"Amaretto","amount_ml":75.0}]',
      20,
      35,
      1,
      9000
    )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
   VALUES (
      'americano',
      'Americano',
      'Suave coctel a base de Campari y Vermut Rosso. 3 hielos.',
      NULL,
      '[{"ingredient_name":"Campari","amount_ml":100.0},{"ingredient_name":"Vermut Rosso","amount_ml":100.0}]',
      19,
      12,
      1,
      7500
    )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
   VALUES (
      'whisky_rocks',
      'Whisky a las Rocas',
      'Whisky premium servido a las rocas. 3 hielos.',
      NULL,
      '[{"ingredient_name":"Whisky","amount_ml":180.0}]',
      15,
      40,
      1,
      8000
    )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available, price)
   VALUES (
      'campari_rocks',
      'Campari a las Rocas',
      'Campari refrescante servido a las rocas. 3 hielos.',
      NULL,
      '[{"ingredient_name":"Campari","amount_ml":180.0}]',
      15,
      25,
      1,
      7500
    )`,
];


async function openDb(): Promise<DbHandle> {
  if (dbPromise == null) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME);
  }

  return dbPromise;
}

async function applySchema(db: DbHandle) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      items TEXT NOT NULL,
      est_time_seconds INTEGER NOT NULL,
      abv REAL,
      is_available INTEGER NOT NULL,
      price INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY NOT NULL,
      bottle_capacity_ml INTEGER NOT NULL,
      dispense_speed_ml_s REAL NOT NULL,
      ice_dispense_time_s INTEGER NOT NULL,
      auto_clean_enabled INTEGER NOT NULL,
      pump_calibrations TEXT,
      carriage_positions TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY NOT NULL,
      ingredient_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      capacity_oz REAL,
      remaining_oz REAL,
      capacity_ml REAL NOT NULL,
      remaining_ml REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      table_number INTEGER NOT NULL,
      qr_value TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      ice_count INTEGER NOT NULL,
      alcohol_oz REAL,
      mixer_oz REAL,
      piscola_intensity TEXT,
      est_time_seconds INTEGER NOT NULL,
      active_step_id TEXT,
      completed_step_ids TEXT NOT NULL,
      skipped_step_ids TEXT NOT NULL,
      is_drink_ready INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      served_at INTEGER,
      queued_at INTEGER,
      guest_name TEXT,
      group_id TEXT,
      split_method TEXT
    );
  `);
}

async function ensureOrderColumns(db: DbHandle) {
  const alterStatements = [
    `ALTER TABLE orders ADD COLUMN queued_at INTEGER`,
    `ALTER TABLE orders ADD COLUMN guest_name TEXT`,
    `ALTER TABLE orders ADD COLUMN group_id TEXT`,
    `ALTER TABLE orders ADD COLUMN split_method TEXT`,
  ];

  for (const statement of alterStatements) {
    try {
      await db.execAsync(statement);
    } catch {
      // Column already exists in previously migrated databases.
    }
  }
}

async function ensureSettingsColumns(db: DbHandle) {
  try {
    await db.execAsync(`ALTER TABLE settings ADD COLUMN pump_calibrations TEXT`);
  } catch {
    // Column already exists
  }
  try {
    await db.execAsync(`ALTER TABLE settings ADD COLUMN carriage_positions TEXT`);
  } catch {
    // Column already exists
  }
}

async function ensureInventoryColumns(db: DbHandle) {
  const alterStatements = [
    `ALTER TABLE inventory ADD COLUMN capacity_ml REAL`,
    `ALTER TABLE inventory ADD COLUMN remaining_ml REAL`,
  ];

  for (const statement of alterStatements) {
    try {
      await db.execAsync(statement);
    } catch {
      // Column already exists in fresh or previously migrated databases.
    }
  }

  try {
    await db.execAsync(`
      UPDATE inventory
      SET capacity_ml = ROUND(capacity_oz * ${ML_PER_OUNCE})
      WHERE capacity_ml IS NULL AND capacity_oz IS NOT NULL;

      UPDATE inventory
      SET remaining_ml = ROUND(remaining_oz * ${ML_PER_OUNCE})
      WHERE remaining_ml IS NULL AND remaining_oz IS NOT NULL;
    `);
  } catch {
    // Fresh ml-only databases do not need oz migration.
  }

  await db.runAsync('UPDATE inventory SET capacity_ml = ? WHERE capacity_ml IS NULL', [
    DEFAULT_BOTTLE_CAPACITY_ML,
  ]);
  await db.runAsync('UPDATE inventory SET remaining_ml = ? WHERE remaining_ml IS NULL', [
    DEFAULT_BOTTLE_CAPACITY_ML,
  ]);
}

async function seedRecipes(db: DbHandle) {
  await db.execAsync(`
    DELETE FROM recipes WHERE id IN ('r1', 'r2', 'r3', 'pisco_sour', 'margarita', 'mojito', 'dry_martini', 'gin_tonic');
    DELETE FROM inventory WHERE id = 'vermut_seco';
  `);

  for (const statement of recipeSeedStatements) {
    await db.execAsync(statement);
  }
}

async function seedSettings(db: DbHandle) {
  await db.runAsync(
    `INSERT OR IGNORE INTO settings (
      id,
      bottle_capacity_ml,
      dispense_speed_ml_s,
      ice_dispense_time_s,
      auto_clean_enabled,
      pump_calibrations,
      carriage_positions
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      DEFAULT_SETTINGS_ID,
      DEFAULT_BOTTLE_CAPACITY_ML,
      15,
      2,
      1,
      '[24.7, 23.6, 20.6, 24.3, 23.8, 16.1, 23.6]',
      '[3600, 2600, 800, 100, 1860, 1600, 1350, 1200]'
    ]
  );
}

async function seedInventory(db: DbHandle) {
  const capOz = Number(mlToOz(DEFAULT_BOTTLE_CAPACITY_ML).toFixed(1));
  for (const item of ingredientCatalog) {
    await db.runAsync(
      `INSERT OR IGNORE INTO inventory (
        id,
        ingredient_name,
        display_name,
        capacity_oz,
        remaining_oz,
        capacity_ml,
        remaining_ml
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.ingredient_name,
        item.display_name,
        capOz,
        capOz,
        DEFAULT_BOTTLE_CAPACITY_ML,
        DEFAULT_BOTTLE_CAPACITY_ML,
      ]
    );
  }
}

async function markSchemaVersion(db: DbHandle) {
  await db.runAsync(
    `INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)`,
    ['schema_version', String(SCHEMA_VERSION)]
  );
}

async function performInit() {
  const db = await openDb();
  console.log('[LocalDatabase] Opening database');

  let currentVersion = 0;
  try {
    const verRow = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_metadata WHERE key = ?',
      ['schema_version']
    );
    if (verRow) {
      currentVersion = parseInt(verRow.value, 10);
    }
  } catch {
    // metadata or table doesn't exist yet
  }

  if (currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
    console.log(`[LocalDatabase] Migrating from version ${currentVersion} to ${SCHEMA_VERSION}`);
    if (currentVersion < 7) {
      try {
        await db.execAsync(`ALTER TABLE recipes ADD COLUMN price INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        console.log('[LocalDatabase] Alter recipes price failed:', e);
      }

      try {
        await db.execAsync(`
          UPDATE recipes SET price = COALESCE((SELECT piscola_price FROM settings WHERE id = 'default'), 7000) WHERE id = 'piscola';
          UPDATE recipes SET price = COALESCE((SELECT negroni_price FROM settings WHERE id = 'default'), 8000) WHERE id = 'negroni';
          UPDATE recipes SET price = COALESCE((SELECT boulevardier_price FROM settings WHERE id = 'default'), 8500) WHERE id = 'boulevardier';
          UPDATE recipes SET price = COALESCE((SELECT godfather_price FROM settings WHERE id = 'default'), 9000) WHERE id = 'godfather';
          UPDATE recipes SET price = COALESCE((SELECT americano_price FROM settings WHERE id = 'default'), 7500) WHERE id = 'americano';
          UPDATE recipes SET price = COALESCE((SELECT whisky_rocks_price FROM settings WHERE id = 'default'), 8000) WHERE id = 'whisky_rocks';
          UPDATE recipes SET price = COALESCE((SELECT campari_rocks_price FROM settings WHERE id = 'default'), 7500) WHERE id = 'campari_rocks';
        `);
      } catch (e) {
        console.log('[LocalDatabase] Migrate recipe prices failed:', e);
      }

      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS settings_new (
            id TEXT PRIMARY KEY NOT NULL,
            bottle_capacity_ml INTEGER NOT NULL,
            dispense_speed_ml_s REAL NOT NULL,
            ice_dispense_time_s INTEGER NOT NULL,
            auto_clean_enabled INTEGER NOT NULL,
            pump_calibrations TEXT,
            carriage_positions TEXT
          );
          INSERT OR IGNORE INTO settings_new (id, bottle_capacity_ml, dispense_speed_ml_s, ice_dispense_time_s, auto_clean_enabled, pump_calibrations, carriage_positions)
          SELECT id, bottle_capacity_ml, dispense_speed_ml_s, ice_dispense_time_s, auto_clean_enabled, pump_calibrations, carriage_positions FROM settings;
          DROP TABLE settings;
          ALTER TABLE settings_new RENAME TO settings;
        `);
      } catch (e) {
        console.log('[LocalDatabase] Clean settings table failed:', e);
      }
    }
  }

  await applySchema(db);
  await ensureOrderColumns(db);
  await ensureSettingsColumns(db);
  await ensureInventoryColumns(db);
  await seedRecipes(db);
  await seedSettings(db);
  await seedInventory(db);
  await markSchemaVersion(db);

  console.log('[LocalDatabase] Schema and seed ready');
}

export const getDb = async () => {
  await initDb();
  return openDb();
};

export const initDb = async () => {
  if (initPromise == null) {
    initPromise = performInit().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
};

export async function resetDatabase() {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM orders;
    DELETE FROM inventory;
    DELETE FROM recipes;
    DELETE FROM settings;
  `);
  await seedSettings(db);
  await seedInventory(db);
  await seedRecipes(db);
  console.log('[LocalDatabase] Database reset complete');
}
