export * from '@cindy/app-runtime/collaborationSettingsStore';
import { createCollaborationSettingsStore } from '@cindy/app-runtime/collaborationSettingsStore';
import { app } from 'electron';
import { desktopMakerLogger } from './logger-adapter.js';
const runtime = createCollaborationSettingsStore({ userDataDirectory: () => app.getPath('userData'), logger: desktopMakerLogger.child('collaboration-settings-store') });
export const { readCollaborationSettings, readCollaborationSettingsState, writeCollaborationSetting, resetCollaborationSettings, __testing } = runtime;
