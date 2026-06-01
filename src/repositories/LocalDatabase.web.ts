import {
  DEFAULT_BOTTLE_CAPACITY_ML,
  ingredientCatalog,
  mlToOz,
  ozToMl,
} from '../utils/drinkConfig';

type RecipeRow = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  items: string;
  est_time_seconds: number;
  abv: number | null;
  is_available: number;
};

type SettingsRow = {
  id: string;
  bottle_capacity_ml: number;
  dispense_speed_ml_s: number;
  ice_dispense_time_s: number;
  auto_clean_enabled: number;
  piscola_price: number;
  whisky_rocks_price: number;
  negroni_price: number;
  gin_tonic_price: number;
};

type MetadataRow = {
  key: string;
  value: string;
};

type InventoryRow = {
  id: string;
  ingredient_name: string;
  display_name: string;
  capacity_oz?: number;
  remaining_oz?: number;
  capacity_ml: number;
  remaining_ml: number;
};

type OrderRow = {
  id: string;
  recipe_id: string;
  recipe_name: string;
  table_number: number;
  qr_value: string;
  requested_at: number;
  status: string;
  ice_count: number;
  alcohol_oz: number | null;
  mixer_oz: number | null;
  piscola_intensity: string | null;
  est_time_seconds: number;
  active_step_id: string | null;
  completed_step_ids: string;
  skipped_step_ids: string;
  is_drink_ready: number;
  started_at: number | null;
  finished_at: number | null;
  served_at: number | null;
  queued_at?: number | null;
  guest_name?: string | null;
  group_id?: string | null;
  split_method?: string | null;
};

type WebDbShape = {
  recipes: RecipeRow[];
  settings: SettingsRow[];
  metadata: MetadataRow[];
  inventory: InventoryRow[];
  orders: OrderRow[];
};

const STORAGE_KEY = 'penpito.web.db';
const DEFAULT_SETTINGS_ID = 'default';

const defaultRecipes: RecipeRow[] = [
  {
    id: 'piscola',
    name: 'Piscola',
    description: 'Pisco con bebida cola con perfiles suave, normal y fuerte.',
    image_url: null,
    items: '[{"ingredient_name":"Pisco","amount_ml":88.71},{"ingredient_name":"Bebida Cola","amount_ml":221.78}]',
    est_time_seconds: 20,
    abv: 14,
    is_available: 1,
  },
  {
    id: 'whisky_rocks',
    name: 'Whisky a la Roca',
    description: 'Whisky servido con 4 hielos.',
    image_url: null,
    items: '[{"ingredient_name":"Whisky","amount_ml":73.93}]',
    est_time_seconds: 12,
    abv: 40,
    is_available: 1,
  },
  {
    id: 'negroni',
    name: 'Negroni',
    description: 'Clasico coctel de gin, campari y vermut rojo con 4 hielos.',
    image_url: null,
    items: '[{"ingredient_name":"Gin","amount_ml":29.57},{"ingredient_name":"Campari","amount_ml":29.57},{"ingredient_name":"Vermut Rojo","amount_ml":29.57}]',
    est_time_seconds: 18,
    abv: 24,
    is_available: 1,
  },
  {
    id: 'gin_tonic',
    name: 'Gin & Tonic',
    description: 'Gin con tonica y 4 hielos.',
    image_url: null,
    items: '[{"ingredient_name":"Gin","amount_ml":73.93},{"ingredient_name":"Tonica","amount_ml":221.78}]',
    est_time_seconds: 15,
    abv: 18,
    is_available: 1,
  },
];

const defaultSettings: SettingsRow = {
  id: DEFAULT_SETTINGS_ID,
  bottle_capacity_ml: DEFAULT_BOTTLE_CAPACITY_ML,
  dispense_speed_ml_s: 15,
  ice_dispense_time_s: 2,
  auto_clean_enabled: 1,
  piscola_price: 5500,
  whisky_rocks_price: 7000,
  negroni_price: 8000,
  gin_tonic_price: 7000,
};

const defaultInventory: InventoryRow[] = ingredientCatalog.map((ingredient) => ({
  id: ingredient.id,
  ingredient_name: ingredient.ingredient_name,
  display_name: ingredient.display_name,
  capacity_oz: Number(mlToOz(DEFAULT_BOTTLE_CAPACITY_ML).toFixed(1)),
  remaining_oz: Number(mlToOz(DEFAULT_BOTTLE_CAPACITY_ML).toFixed(1)),
  capacity_ml: DEFAULT_BOTTLE_CAPACITY_ML,
  remaining_ml: DEFAULT_BOTTLE_CAPACITY_ML,
}));

function normalizeInventoryRow(row: Partial<InventoryRow>): InventoryRow {
  const capacityMl =
    row.capacity_ml ?? (row.capacity_oz == null ? DEFAULT_BOTTLE_CAPACITY_ML : Math.round(ozToMl(row.capacity_oz)));
  const remainingMl =
    row.remaining_ml ?? (row.remaining_oz == null ? capacityMl : Math.round(ozToMl(row.remaining_oz)));

  return {
    id: String(row.id),
    ingredient_name: String(row.ingredient_name),
    display_name: String(row.display_name),
    capacity_oz: Number(mlToOz(capacityMl).toFixed(1)),
    remaining_oz: Number(mlToOz(remainingMl).toFixed(1)),
    capacity_ml: Math.round(capacityMl),
    remaining_ml: Math.round(remainingMl),
  };
}

function buildDefaultState(): WebDbShape {
  return {
    recipes: [...defaultRecipes],
    settings: [{ ...defaultSettings }],
    metadata: [{ key: 'schema_version', value: '6' }],
    inventory: [...defaultInventory],
    orders: [],
  };
}

function loadState(): WebDbShape {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (!raw) {
    return buildDefaultState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WebDbShape>;
    return {
      recipes: parsed.recipes ?? [...defaultRecipes],
      settings: parsed.settings ?? [{ ...defaultSettings }],
      metadata: parsed.metadata ?? [{ key: 'schema_version', value: '6' }],
      inventory:
        parsed.inventory?.filter((item) => item.id !== 'vermut_seco').map(normalizeInventoryRow) ??
        [...defaultInventory],
      orders: parsed.orders ?? [],
    };
  } catch {
    return buildDefaultState();
  }
}

function saveState(state: WebDbShape) {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
}

class WebDatabase {
  async execAsync(sql: string): Promise<void> {
    const state = loadState();

    if (sql.includes('DELETE FROM recipes')) {
      state.recipes = state.recipes.filter(
        (recipe) =>
          !['r1', 'r2', 'r3', 'pisco_sour', 'margarita', 'mojito', 'dry_martini'].includes(recipe.id)
      );
    }

    if (sql.includes('DELETE FROM inventory WHERE id = \'vermut_seco\'')) {
      state.inventory = state.inventory.filter((item) => item.id !== 'vermut_seco');
    }

    if (sql.includes('INSERT OR REPLACE INTO recipes')) {
      state.recipes = [...defaultRecipes];
    }

    if (sql.includes('INSERT OR IGNORE INTO inventory')) {
      const mergedInventory = [...state.inventory];

      defaultInventory.forEach((item) => {
        if (!mergedInventory.some((entry) => entry.id === item.id)) {
          mergedInventory.push({ ...item });
        }
      });

      state.inventory = mergedInventory.filter((item) => item.id !== 'vermut_seco');
    }

    saveState(state);
  }

  async getAllAsync<T>(sql: string): Promise<T[]> {
    const state = loadState();

    if (sql.includes('FROM recipes')) {
      return state.recipes as T[];
    }

    if (sql.includes('FROM inventory')) {
      return state.inventory as T[];
    }

    if (sql.includes('FROM orders')) {
      return [...state.orders].sort((a, b) => b.requested_at - a.requested_at) as T[];
    }

    return [];
  }

  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const state = loadState();

    if (sql.includes('FROM recipes WHERE id = ?')) {
      const id = String(params[0] ?? '');
      return (state.recipes.find((recipe) => recipe.id === id) as T) ?? null;
    }

    if (sql.includes('FROM settings')) {
      return (state.settings.find((item) => item.id === DEFAULT_SETTINGS_ID) as T) ?? null;
    }

    if (sql.includes('FROM app_metadata')) {
      const key = String(params[0] ?? '');
      return (state.metadata.find((item) => item.key === key) as T) ?? null;
    }

    if (sql.includes('FROM inventory WHERE id = ?')) {
      const id = String(params[0] ?? '');
      return (state.inventory.find((item) => item.id === id) as T) ?? null;
    }

    if (sql.includes('FROM orders WHERE id = ?')) {
      const id = String(params[0] ?? '');
      return (state.orders.find((item) => item.id === id) as T) ?? null;
    }

    return null;
  }

  async runAsync(sql: string, params: unknown[]): Promise<void> {
    const state = loadState();

    if (sql.includes('INTO recipes')) {
      const row: RecipeRow = {
        id: String(params[0]),
        name: String(params[1]),
        description: (params[2] as string | null) ?? null,
        image_url: (params[3] as string | null) ?? null,
        items: String(params[4]),
        est_time_seconds: Number(params[5]),
        abv: params[6] == null ? null : Number(params[6]),
        is_available: Number(params[7]),
      };

      state.recipes = state.recipes.filter((recipe) => recipe.id !== row.id);
      state.recipes.push(row);
      saveState(state);
      return;
    }

    if (sql.includes('INTO settings')) {
      const row: SettingsRow = {
        id: String(params[0]),
        bottle_capacity_ml: Number(params[1]),
        dispense_speed_ml_s: Number(params[2]),
        ice_dispense_time_s: Number(params[3]),
        auto_clean_enabled: Number(params[4]),
        piscola_price: Number(params[5]),
        whisky_rocks_price: Number(params[6]),
        negroni_price: Number(params[7]),
        gin_tonic_price: Number(params[8]),
      };

      state.settings = state.settings.filter((item) => item.id !== row.id);
      state.settings.push(row);
      saveState(state);
      return;
    }

    if (sql.includes('INTO app_metadata')) {
      const row: MetadataRow = {
        key: String(params[0]),
        value: String(params[1]),
      };
      state.metadata = state.metadata.filter((item) => item.key !== row.key);
      state.metadata.push(row);
      saveState(state);
      return;
    }

    if (sql.includes('INTO inventory')) {
      const capacityMl =
        params[5] == null ? Math.round(ozToMl(Number(params[3]))) : Math.round(Number(params[5]));
      const remainingMl =
        params[6] == null ? Math.round(ozToMl(Number(params[4]))) : Math.round(Number(params[6]));
      const row: InventoryRow = {
        id: String(params[0]),
        ingredient_name: String(params[1]),
        display_name: String(params[2]),
        capacity_oz: Number(params[3]),
        remaining_oz: Number(params[4]),
        capacity_ml: capacityMl,
        remaining_ml: remainingMl,
      };

      state.inventory = state.inventory.filter((item) => item.id !== row.id);
      state.inventory.push(row);
      saveState(state);
      return;
    }

    if (sql.includes('INTO orders')) {
      const row: OrderRow = {
        id: String(params[0]),
        recipe_id: String(params[1]),
        recipe_name: String(params[2]),
        table_number: Number(params[3]),
        qr_value: String(params[4]),
        requested_at: Number(params[5]),
        status: String(params[6]),
        ice_count: Number(params[7]),
        alcohol_oz: params[8] == null ? null : Number(params[8]),
        mixer_oz: params[9] == null ? null : Number(params[9]),
        piscola_intensity: (params[10] as string | null) ?? null,
        est_time_seconds: Number(params[11]),
        active_step_id: (params[12] as string | null) ?? null,
        completed_step_ids: String(params[13]),
        skipped_step_ids: String(params[14]),
        is_drink_ready: Number(params[15]),
        started_at: params[16] == null ? null : Number(params[16]),
        finished_at: params[17] == null ? null : Number(params[17]),
        served_at: params[18] == null ? null : Number(params[18]),
        queued_at: params[19] == null ? null : Number(params[19]),
        guest_name: (params[20] as string | null) ?? null,
        group_id: (params[21] as string | null) ?? null,
        split_method: (params[22] as string | null) ?? null,
      };

      state.orders = state.orders.filter((item) => item.id !== row.id);
      state.orders.push(row);
      saveState(state);
      return;
    }

    if (sql.includes('DELETE FROM orders WHERE table_number = ?')) {
      const tableNumber = Number(params[0]);
      state.orders = state.orders.filter((item) => item.table_number !== tableNumber);
      saveState(state);
      return;
    }

    if (sql.includes('DELETE FROM orders WHERE id = ?')) {
      const id = String(params[0]);
      state.orders = state.orders.filter((item) => item.id !== id);
      saveState(state);
    }
  }
}

const webDb = new WebDatabase();
let initPromise: Promise<void> | null = null;

export const getDb = async () => {
  await initDb();
  return webDb;
};

export const initDb = async () => {
  if (initPromise == null) {
    initPromise = Promise.resolve().then(() => {
      const state = loadState();
      const nextState: WebDbShape = {
        recipes: [...defaultRecipes],
        settings:
          state.settings.length > 0
            ? state.settings.filter((item) => item.id === DEFAULT_SETTINGS_ID)
            : [{ ...defaultSettings }],
        metadata: [{ key: 'schema_version', value: '6' }],
        inventory: (() => {
          const existing = state.inventory?.filter((item) => item.id !== 'vermut_seco') ?? [];

          return defaultInventory.map((item) => {
            const current = existing.find((entry) => entry.id === item.id);
            return current ? normalizeInventoryRow(current) : { ...item };
          });
        })(),
        orders: state.orders ?? [],
      };
      saveState(nextState);
    });
  }

  await initPromise;
};
