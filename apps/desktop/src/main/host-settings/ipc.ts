import { readModelSettings, validateModelSettingsChange, commitModelSettings } from './additionalModels.js';
import { applyAdditionalSettings } from './additionalApplication.js';
import { configureAdditionalNativeOperations } from './additionalRuntime.js';
import { nativeSettingsOperations } from './additionalNative.js';
import { configureHostSettingsApplication } from './index.js';
import { isManagedCloudInstance } from './personalization.js';
import { registerHostAppSettingsSections } from './appSettingsSections.js';

let registered = false;
/**
 * Wires the Host settings service. The app window keeps its own settings; the
 * main window learns whether it runs on a managed cloud instance from its launch argument.
 */
export function registerHostSettingsIpc(databaseWarningChanged: () => void): void {
  if (registered) return;
  registered = true;
  configureAdditionalNativeOperations(nativeSettingsOperations);
  configureHostSettingsApplication({ models: { read: readModelSettings, validate: validateModelSettingsChange, commit: commitModelSettings }, additional: applyAdditionalSettings, databaseWarning: databaseWarningChanged });
  // Ordinary desktops register only the app's own settings sections.
  if (isManagedCloudInstance()) registerHostAppSettingsSections();
}
