import { createContext, useContext } from 'react';
import type { SettingsSearchEntry } from './settingsSearchTypes';

/** Page-owned reveal handlers consume the same resolved target as the scroll lifecycle. */
export const SettingsSearchNavigationContext = createContext<{
  entry: SettingsSearchEntry | null;
  activation: number;
}>({ entry: null, activation: 0 });

export function useSettingsSearchNavigation() {
  return useContext(SettingsSearchNavigationContext);
}
