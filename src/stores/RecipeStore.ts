import { create } from 'zustand';
import { Recipe } from '../models';
import { recipeRepository } from '../repositories/RecipeRepository';

interface RecipeState {
  recipes: Recipe[];
  isLoading: boolean;
  error: string | null;
  loadRecipes: () => Promise<void>;
  addRecipe: (recipe: Recipe) => Promise<void>;
}

export const useRecipeStore = create<RecipeState>((set, get) => ({
  recipes: [],
  isLoading: false,
  error: null,
  loadRecipes: async () => {
    set({ isLoading: true, error: null });
    try {
      const dbRecipes = await recipeRepository.getAllRecipes();
      set({ recipes: dbRecipes, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load recipes', isLoading: false });
    }
  },
  addRecipe: async (recipe: Recipe) => {
    try {
      await recipeRepository.saveRecipe(recipe);
      await get().loadRecipes();
    } catch (error) {
      set({ error: 'Failed to save recipe' });
    }
  }
}));
