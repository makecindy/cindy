import {app} from 'electron';
import {desktopMakerLogger} from './logger-adapter.js';
import {createGitSafetySettingsStore} from '@cindy/app-runtime/gitSafetySettingsStore';
const runtime=createGitSafetySettingsStore({userDataDirectory:()=>app.getPath('userData'),logger:desktopMakerLogger.child('git-safety-settings-store')});
export const {readGitSafetySettings,readGitSafetySettingsState,writeGitSafetyMode,writeGitSafetyAutoSnapshotEnabled,resetGitSafetySettings,__testing} = runtime;
export {type GitSafetyMode,type GitSafetySettings} from '@cindy/app-runtime/gitSafetySettingsStore';
