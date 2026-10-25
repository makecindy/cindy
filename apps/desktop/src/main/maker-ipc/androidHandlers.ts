import {registerAndroidAutomationHandlers as register,type AndroidAutomationHandlerDeps} from '@cindy/app-runtime/androidHandlers';
import {readAndroidAutomationSettingsState,writeAndroidAdbPathOverride,writeAndroidDefaultDeviceSerial} from '../android-automation-settings-store.js';
import {getAndroidStatusSummary,prepareAndroidAdb} from '../mcp-integrations/android.js';
import type {IpcHandlerRegistry} from './ipcHandlerRegistry.js';
export {normalizeAndroidStatusResult,type AndroidAutomationHandlerDeps} from '@cindy/app-runtime/androidHandlers';
export function registerAndroidAutomationHandlers(registry:IpcHandlerRegistry,deps:Partial<AndroidAutomationHandlerDeps>={}) {
register(registry,{getStatusSummary:getAndroidStatusSummary,getSettingsState:readAndroidAutomationSettingsState,setDefaultDeviceSerial:writeAndroidDefaultDeviceSerial,setAdbPathOverride:writeAndroidAdbPathOverride,prepareAdb:prepareAndroidAdb,...deps});
}
