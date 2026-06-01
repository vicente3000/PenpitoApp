import * as SQLite from 'expo-sqlite';
import {
  DEFAULT_BOTTLE_CAPACITY_ML,
  ML_PER_OUNCE,
  ingredientCatalog,
  mlToOz,
} from '../utils/drinkConfig';

const DB_NAME = 'penpito.db';
const SCHEMA_VERSION = 6;
const DEFAULT_SETTINGS_ID = 'default';

type DbHandle = Awaited<ReturnType<typeof SQLite.openDatabaseAsync>>;

let dbPromise: Promise<DbHandle> | null = null;
let initPromise: Promise<void> | null = null;

const recipeSeedStatements = [
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available)
   VALUES (
     'piscola',
     'Piscola',
     'Pisco con bebida cola con perfiles suave, normal y fuerte.',
     NULL,
     '[{"ingredient_name":"Pisco","amount_ml":88.71},{"ingredient_name":"Bebida Cola","amount_ml":221.78}]',
     20,
     14,
     1
   )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available)
   VALUES (
     'whisky_rocks',
     'Whisky a la Roca',
     'Whisky servido con 4 hielos.',
     NULL,
     '[{"ingredient_name":"Whisky","amount_ml":73.93}]',
     12,
     40,
     1
   )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available)
   VALUES (
     'negroni',
     'Negroni',
     'Clasico coctel de gin, campari y vermut rojo con 4 hielos.',
     NULL,
     '[{"ingredient_name":"Gin","amount_ml":29.57},{"ingredient_name":"Campari","amount_ml":29.57},{"ingredient_name":"Vermut Rojo","amount_ml":29.57}]',
     18,
     24,
     1
   )`,
  `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available)
   VALUES (
     'gin_tonic',
     'Gin & Tonic',
     'Gin con tonica y 4 hielos.',
     NULL,
     '[{"ingredient_name":"Gin","amount_ml":73.93},{"ingredient_name":"Tonica","amount_ml":221.78}]',
     15,
     18,
     1
   )`,
];

const inventorySeedStatements = ingredientCatalog.map(
  (ingredient) => `INSERT OR IGNORE INTO inventory (
     id,
     ingredient_name,
     display_name,
     capacity_oz,
     remaining_oz,
     capacity_ml,
     remaining_ml
   )
   VALUES (
     '${ingredient.id}',
     '${ingredient.ingredient_name}',
     '${ingredient.display_name}',
     ${Number(mlToOz(DEFAULT_BOTTLE_CAPACITY_ML).toFixed(1))},
     ${Number(mlToOz(DEFAULT_BOTTLE_CAPACITY_ML).toFixed(1))},
     ${DEFAULT_BOTTLE_CAPACITY_ML},
     ${DEFAULT_BOTTLE_CAPACITY_ML}
   )`
);

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
      is_available INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY NOT NULL,
      bottle_capacity_ml INTEGER NOT NULL,
      dispense_speed_ml_s REAL NOT NULL,
      ice_dispense_time_s INTEGER NOT NULL,
      auto_clean_enabled INTEGER NOT NULL,
      piscola_price INTEGER NOT NULL DEFAULT 5500,
      whisky_rocks_price INTEGER NOT NULL DEFAULT 7000,
      negroni_price INTEGER NOT NULL DEFAULT 8000,
      gin_tonic_price INTEGER NOT NULL DEFAULT 7000
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
  const alterStatements = [
    `ALTER TABLE settings ADD COLUMN piscola_price INTEGER NOT NULL DEFAULT 5500`,
    `ALTER TABLE settings ADD COLUMN whisky_rocks_price INTEGER NOT NULL DEFAULT 7000`,
    `ALTER TABLE settings ADD COLUMN negroni_price INTEGER NOT NULL DEFAULT 8000`,
    `ALTER TABLE settings ADD COLUMN gin_tonic_price INTEGER NOT NULL DEFAULT 7000`,
  ];

  for (const statement of alterStatements) {
    try {
      await db.execAsync(statement);
    } catch {
      // Column already exists in previously migrated databases.
    }
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
    DELETE FROM recipes WHERE id IN ('r1', 'r2', 'r3', 'pisco_sour', 'margarita', 'mojito', 'dry_martini');
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
      piscola_price,
      whisky_rocks_price,
      negroni_price,
      gin_tonic_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [DEFAULT_SETTINGS_ID, DEFAULT_BOTTLE_CAPACITY_ML, 15, 2, 1, 5500, 7000, 8000, 7000]
  );
}

async function seedInventory(db: DbHandle) {
  for (const statement of inventorySeedStatements) {
    await db.execAsync(statement);
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
