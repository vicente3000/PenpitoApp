import { getDb } from './LocalDatabase';
import { Recipe } from '../models';

export class RecipeRepository {
  async getAllRecipes(): Promise<Recipe[]> {
    const db = await getDb();
    const results = await db.getAllAsync<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      items: string;
      est_time_seconds: number;
      abv: number | null;
      is_available: number;
    }>('SELECT * FROM recipes');

    return results.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      image_url: r.image_url || undefined,
      items: JSON.parse(r.items),
      est_time_seconds: r.est_time_seconds,
      abv: r.abv || undefined,
      is_available: r.is_available === 1,
    }));
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    const db = await getDb();
    const result = await db.getFirstAsync<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      items: string;
      est_time_seconds: number;
      abv: number | null;
      is_available: number;
    }>('SELECT * FROM recipes WHERE id = ?', [id]);

    if (!result) return null;

    return {
      id: result.id,
      name: result.name,
      description: result.description || undefined,
      image_url: result.image_url || undefined,
      items: JSON.parse(result.items),
      est_time_seconds: result.est_time_seconds,
      abv: result.abv || undefined,
      is_available: result.is_available === 1,
    };
  }

  async saveRecipe(recipe: Recipe): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO recipes (id, name, description, image_url, items, est_time_seconds, abv, is_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recipe.id,
        recipe.name,
        recipe.description || null,
        recipe.image_url || null,
        JSON.stringify(recipe.items),
        recipe.est_time_seconds,
        recipe.abv || null,
        recipe.is_available ? 1 : 0
      ]
    );
  }
}

export const recipeRepository = new RecipeRepository();
