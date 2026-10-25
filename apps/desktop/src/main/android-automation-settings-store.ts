import {app} from 'electron';
import {desktopMakerLogger} from './maker-host/logger-adapter.js';
import {createAndroidAutomationSettings} from '@cindy/app-runtime/androidAutomationSettings';
const runtime=createAndroidAutomationSettings({userDataPath:()=>app.getPath('userData'),log:desktopMakerLogger.child('android-automation-settings-store')});
export const {readAndroidAutomationSettings,readAndroidAutomationSettingsState,writeAndroidDefaultDeviceSerial,writeAndroidAdbPathOverride,resetAndroidAutomationSettings,__testing}=runtime;
export type {AndroidAutomationSettings} from '@cindy/app-runtime/androidAutomationSettings';
