import { app } from 'electron';
import { createBrowserBackendSettingsStore } from './browser-backend-settings-store.js';
const runtime = createBrowserBackendSettingsStore(() => app.getPath('userData'));
export type { BrowserBackendSettings } from './browser-backend-settings-store.js';
export const { readBrowserBackendSettings, readBrowserBackendSettingsState, writeBrowserBackendKind, writeBrowserUseRealProfile, resetBrowserBackendSettings, __testing } = runtime;
