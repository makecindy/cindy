import {app} from 'electron';
import {desktopMakerLogger} from './logger-adapter.js';
import {createLspModeSettings} from '@cindy/app-runtime/lspModeSettings';
export type {LspModeSettings} from '@cindy/app-runtime/lspModeSettings';
export const {readLspModeSettings,writeLspModeEnabled}=createLspModeSettings({userDataPath:()=>app.getPath('userData'),log:desktopMakerLogger.child('lsp-mode-store')});
