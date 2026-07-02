import { BottleInventory, DrinkPreparationOptions, PiscolaIntensity, Recipe } from '../models';

export const ML_PER_OUNCE = 30.0;

export const DEFAULT_BOTTLE_CAPACITY_ML = 1000;

export const ingredientCatalog = [
  { id: 'pisco', ingredient_name: 'Pisco', display_name: 'Botella de Pisco' },
  { id: 'amaretto', ingredient_name: 'Amaretto', display_name: 'Botella de Amaretto' },
  { id: 'gin', ingredient_name: 'Gin', display_name: 'Botella de Gin' },
  { id: 'campari', ingredient_name: 'Campari', display_name: 'Botella de Campari' },
  { id: 'vermut_rosso', ingredient_name: 'Vermut Rosso', display_name: 'Botella de Vermut Rosso' },
  { id: 'whisky', ingredient_name: 'Whisky', display_name: 'Botella de Whisky' },
  { id: 'coca_cola', ingredient_name: 'Coca-Cola', display_name: 'Botella de Coca-Cola' },
] as const;

export const piscolaProfiles: Record<
  PiscolaIntensity,
  { alcoholOz: number; mixerOz: number; defaultIceCount: number; label: string }
> = {
  suave: {
    alcoholOz: 2.0,
    mixerOz: 8.5,
    defaultIceCount: 5,
    label: 'Suave',
  },
  normal: {
    alcoholOz: 3.0,
    mixerOz: 7.5,
    defaultIceCount: 4,
    label: 'Normal',
  },
  fuerte: {
    alcoholOz: 4.5,
    mixerOz: 6.5,
    defaultIceCount: 3,
    label: 'Fuerte',
  },
};

export function ozToMl(oz: number) {
  return oz * ML_PER_OUNCE;
}

export function mlToOz(ml: number) {
  return ml / ML_PER_OUNCE;
}

export function formatOz(value: number) {
  return `${value.toFixed(1)} oz`;
}

export function formatMl(value: number) {
  return `${Math.round(value).toLocaleString('es-CL')} ml`;
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount);
}

export function getDefaultIceCount(recipeId: string, intensity: PiscolaIntensity = 'normal') {
  if (recipeId === 'piscola') {
    return piscolaProfiles[intensity].defaultIceCount;
  }

  if (recipeId === 'whisky_rocks' || recipeId === 'negroni' || recipeId === 'gin_tonic') {
    return 4;
  }

  return 0;
}

export function getRecipeUsageMl(recipe: Recipe, options: DrinkPreparationOptions = {}) {
  if (recipe.id === 'piscola') {
    return [
      {
        ingredient_name: 'Pisco',
        amount_ml: Number(
          ozToMl(options.alcoholOz ?? piscolaProfiles[options.piscolaIntensity ?? 'normal'].alcoholOz).toFixed(0)
        ),
      },
      {
        ingredient_name: 'Coca-Cola',
        amount_ml: Number(
          ozToMl(options.mixerOz ?? piscolaProfiles[options.piscolaIntensity ?? 'normal'].mixerOz).toFixed(0)
        ),
      },
    ];
  }

  return recipe.items.map((item) => ({
    ingredient_name: item.ingredient_name,
    amount_ml: Number(item.amount_ml.toFixed(0)),
  }));
}

export function getInventoryShortage(
  inventory: BottleInventory[],
  recipe: Recipe,
  options: DrinkPreparationOptions = {}
) {
  const usage = getRecipeUsageMl(recipe, options);

  return usage
    .map((item) => {
      const bottle = inventory.find((entry) => entry.ingredient_name === item.ingredient_name);
      const remaining = bottle?.remaining_ml ?? 0;

      if (remaining >= item.amount_ml) {
        return null;
      }

      return {
        ingredient_name: item.ingredient_name,
        display_name: bottle?.display_name ?? item.ingredient_name,
        missing_ml: Math.round(item.amount_ml - remaining),
        remaining_ml: Math.round(remaining),
        required_ml: Math.round(item.amount_ml),
      };
    })
    .filter(
      (
        item
      ): item is {
        ingredient_name: string;
        display_name: string;
        missing_ml: number;
        remaining_ml: number;
        required_ml: number;
      } => item !== null
    );
}

export function canPrepareRecipe(
  inventory: BottleInventory[],
  recipe: Recipe,
  options: DrinkPreparationOptions = {}
) {
  return getInventoryShortage(inventory, recipe, options).length === 0;
}

export function getRecipeServingsCount(
  inventory: BottleInventory[],
  recipe: Recipe,
  options: DrinkPreparationOptions = {}
) {
  const usage = getRecipeUsageMl(recipe, options);

  if (usage.length === 0) {
    return 0;
  }

  const servings = usage.map((item) => {
    const bottle = inventory.find((entry) => entry.ingredient_name === item.ingredient_name);
    const remaining = bottle?.remaining_ml ?? 0;

    if (item.amount_ml <= 0) {
      return 0;
    }

    return Math.floor(remaining / item.amount_ml);
  });

  return Math.max(0, Math.min(...servings));
}

export function getRecipeDefaultOptions(recipe: Recipe, intensity: PiscolaIntensity = 'normal'): DrinkPreparationOptions {
  if (recipe.id !== 'piscola') {
    return {
      iceCount: getDefaultIceCount(recipe.id),
    };
  }

  const profile = piscolaProfiles[intensity];
  return {
    iceCount: profile.defaultIceCount,
    alcoholOz: profile.alcoholOz,
    mixerOz: profile.mixerOz,
    piscolaIntensity: intensity,
  };
}

export function buildCartItemLabel(recipe: Recipe, options: DrinkPreparationOptions) {
  if (recipe.id !== 'piscola') {
    return recipe.name;
  }

  const intensity = options.piscolaIntensity ?? 'normal';
  return `${recipe.name} ${piscolaProfiles[intensity].label}`;
}
