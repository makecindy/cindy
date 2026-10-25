import {app} from 'electron';
import {desktopMakerLogger} from './logger-adapter.js';
import {createGoalSettingsStore} from '@cindy/app-runtime/goal/settings';
const runtime=createGoalSettingsStore({userDataDirectory:()=>app.getPath('userData'),logger:desktopMakerLogger.child('goal-settings-store')});
export const {readGoalSettings,readGoalSettingsState,writeGoalSettings,resetGoalSettings,__testing}=runtime;
export type {GoalSettings} from '@cindy/app-runtime/goal/settings';
