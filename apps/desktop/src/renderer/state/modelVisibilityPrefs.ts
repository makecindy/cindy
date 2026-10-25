/** Original owner preferences; React/Chromium are platform adapters. */
import {useSyncExternalStore} from 'react';
import {createModelVisibilityPreferences} from '@cindy/model-providers/model-plane/modelVisibilityPreferences';
import {hasAnyProviderModelOverride,hasProviderModelHistory} from './providerModelMemory';
import {hasAnyModelEngineOverride} from './modelEnginePrefs';
import {listModelFavorites} from './modelFavorites';
import {createLogger} from '@/lib/logger';
export type {ModelVisibilityInitializationFailure} from '@cindy/model-providers/model-plane/modelVisibilityPreferences';
const preferences=createModelVisibilityPreferences({
  available:()=>typeof window !== 'undefined',
  storage:()=>window.localStorage,
  locks:()=>typeof navigator === 'undefined' ? undefined : navigator.locks,
  claimLegacyOwner:()=>window.electronAPI?.maker?.claimLegacyModelVisibilityOwner?.(),
  syncVisibility:(...args)=>window.electronAPI?.maker?.syncModelVisibility?.(...args),
  hasModelPreferenceHistory:()=>hasAnyProviderModelOverride() || hasProviderModelHistory()
    || hasAnyModelEngineOverride() || listModelFavorites().length !== 0,
  log:createLogger('ModelVisibilityPrefs'),
  subscribeStorage:listener=>{
    if(typeof window.addEventListener !== 'function')return ()=>{};
    window.addEventListener('storage',listener);
    return ()=>window.removeEventListener('storage',listener);
  },
});
export const {getModelVisibilityInitializationFailure, getModelVisibilityVersion, setModelVisibilityOwner, migrateModelVisibilityDefaults, isModelEnabled, setModelVisibility, setManyVisibility, setModelVisibilities, resetModelVisibilities, isModelVisibilityCustomized, __resetForTest, subscribe, __STORAGE_KEY}=preferences;
export function useModelVisibilityVersion():number{
  return useSyncExternalStore(subscribe,getModelVisibilityVersion,getModelVisibilityVersion);
}
if(import.meta.hot)import.meta.hot.dispose(preferences.dispose);
