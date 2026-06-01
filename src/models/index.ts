export interface RecipeItem {
  ingredient_name: string;
  amount_ml: number;
}

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  image_url?: string;
  items: RecipeItem[];
  est_time_seconds: number;
  abv?: number;
  is_available: boolean;
}

export interface BottleInventory {
  id: string;
  ingredient_name: string;
  display_name: string;
  capacity_ml: number;
  remaining_ml: number;
}

export type PreparationStepId =
  | 'cup_dispenser'
  | 'ice_dispenser'
  | 'alcohol_dispenser'
  | 'agitation_system'
  | 'carbonated_station'
  | 'ready';

export interface MachineState {
  isOn: boolean;
  status: 'idle' | 'preparing' | 'cleaning' | 'error';
  errorMessage?: string;
  currentRecipeId?: string;
  requestedIceCount?: number;
  activeStepId?: PreparationStepId;
  completedStepIds?: PreparationStepId[];
  skippedStepIds?: PreparationStepId[];
  isDrinkReady?: boolean;
}

export interface DeviceCommand {
  cmd: string;
  val: string;
  iceCount?: number;
  alcoholOz?: number;
  mixerOz?: number;
}

export type PiscolaIntensity = 'suave' | 'normal' | 'fuerte';
export type BillSplitMethod = 'pay_own' | 'equal_split' | 'host_pays';
export type AppEntryType = 'table' | 'waiter' | 'admin';

export interface DrinkPreparationOptions {
  iceCount?: number;
  alcoholOz?: number;
  mixerOz?: number;
  piscolaIntensity?: PiscolaIntensity;
}

export type DrinkOrderStatus = 'queued' | 'preparing' | 'ready' | 'served' | 'failed';

export interface DrinkOrder {
  id: string;
  recipe_id: string;
  recipe_name: string;
  table_number: number;
  qr_value: string;
  requested_at: number;
  status: DrinkOrderStatus;
  ice_count: number;
  alcohol_oz?: number;
  mixer_oz?: number;
  piscola_intensity?: PiscolaIntensity;
  est_time_seconds: number;
  active_step_id?: PreparationStepId;
  completed_step_ids: PreparationStepId[];
  skipped_step_ids: PreparationStepId[];
  is_drink_ready: boolean;
  started_at?: number;
  finished_at?: number;
  served_at?: number;
  queued_at?: number;
  guest_name?: string;
  group_id?: string;
  split_method?: BillSplitMethod;
}

export interface PreparationRecord {
  id: string;
  recipe_id: string;
  timestamp: number;
  status: 'success' | 'failed' | 'cancelled';
}

export interface MachineSettings {
  bottle_capacity_ml: number;
  dispense_speed_ml_s: number;
  ice_dispense_time_s: number;
  auto_clean_enabled: boolean;
  piscola_price: number;
  whisky_rocks_price: number;
  negroni_price: number;
  gin_tonic_price: number;
}

export interface SessionGuest {
  id: string;
  name: string;
  joined_at: number;
}

export interface TableSession {
  table_number: number;
  qr_value: string;
  guests: SessionGuest[];
  split_method: BillSplitMethod;
  host_guest_id?: string;
  tip_percentage: number;
}

export type AppEntryQr =
  | {
      type: 'table';
      qr_value: string;
      table_number: number;
    }
  | {
      type: 'waiter';
      qr_value: string;
    }
  | {
      type: 'admin';
      qr_value: string;
    };
