import {app} from 'electron';
import {createLogger} from '../logger.js';
import {outboundFetch} from '../maker-host/outbound-fetch.js';
import {readAndroidAutomationSettings} from '../android-automation-settings-store.js';
import {createAndroidRuntime} from '@cindy/app-runtime/androidRuntime';
const runtime=createAndroidRuntime({getPath:name=>app.getPath(name),getAppPath:()=>app.getAppPath(),resourcesPath:()=>process.resourcesPath,logger:createLogger('mcp/cindy_android'),readAndroidAutomationSettings:()=>readAndroidAutomationSettings(),outboundFetch:(...args)=>outboundFetch(...args)});
export const {clearAndroidStateSnapshotsForTest,setServerPreExistedForTest,disposeAndroidAdb,setAndroidPlatformToolsDownloadTimeoutForTest,setAndroidAutomationSettingsReaderForTest,resolveAdbCommandDetails,prepareAndroidAdb,callAndroidDriverTool,getAndroidStatusSummary,getAndroidMcpDeps}=runtime;
export type {AndroidMcpDepsOptions} from '@cindy/app-runtime/androidRuntime';
