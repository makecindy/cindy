import { app } from 'electron';
import { createUserRecipeLoader } from './loader.js';
const runtime = createUserRecipeLoader(() => app.getPath('userData'));
export type { UserRecipesResult } from './loader.js';
export const { buildUserRecipes, userRecipesDir, loadUserBrowserRecipes } = runtime;
