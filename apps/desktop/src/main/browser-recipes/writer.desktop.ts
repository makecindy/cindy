import { shell } from 'electron';
import { userRecipesDir } from './loader.desktop.js';
import { createUserRecipeWriter } from './writer.js';
const runtime = createUserRecipeWriter({ userRecipesDir, openPath: path => shell.openPath(path) });
export type { WriteUserRecipeResult } from './writer.js';
export const { writeUserRecipe, resetSiteRecipe, openUserRecipesDir } = runtime;
