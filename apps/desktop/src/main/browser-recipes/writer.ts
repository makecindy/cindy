import {shell} from 'electron';
import {createLogger} from '../logger.js';
import {userRecipesDir} from './loader.js';
import {createBrowserRecipeWriter} from '@cindy/app-runtime/browserRecipeWriter';
const runtime=createBrowserRecipeWriter({userRecipesDir:()=>userRecipesDir(),openPath:dir=>shell.openPath(dir),log:createLogger('browser-recipes')});
export const {writeUserRecipe,resetSiteRecipe,openUserRecipesDir}=runtime;
export type {WriteUserRecipeResult} from '@cindy/app-runtime/browserRecipeWriter';
