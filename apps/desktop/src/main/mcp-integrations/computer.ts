import {app} from 'electron';
import {createLogger} from '../logger.js';
import {outboundFetch} from '../maker-host/outbound-fetch.js';
import {resolveDesktopOutboundProxy} from '../maker-host/outbound-proxy-resolver.js';
import {createComputerRuntime} from '@cindy/app-runtime/computerRuntime';
import * as ownership from '../remote-desktop/inputOwnership';
const runtime=createComputerRuntime({getPath:name=>app.getPath(name),logger:createLogger('mcp/cindy_computer'),outboundFetch:(...args)=>outboundFetch(...args),resolveDesktopOutboundProxy:url=>resolveDesktopOutboundProxy(url),
 agentDesktopInputRevision:()=>ownership.agentDesktopInputRevision(),desktopInputRevision:()=>ownership.desktopInputRevision(),
 hasRemoteDesktopInput:()=>ownership.hasRemoteDesktopInput(),isAgentDesktopInputActive:()=>ownership.isAgentDesktopInputActive(),
 isHumanDesktopInputActive:()=>ownership.isHumanDesktopInputActive(),withAgentDesktopInput:(...args)=>ownership.withAgentDesktopInput(...args),
 isSecureTarget:async target=>(await import('../input-handoff/macDriver.js')).isSecureInputTarget(target),
});
export const {getComputerDriverAppBundlePath,resetComputerDriverPermissionProbeCacheForTests,isComputerDriverPermissionProbePaused,pauseComputerDriverPermissionProbe,resumeComputerDriverPermissionProbe,isInstallLockHolderAlive,clearStaleCuaInstallLock,sampleInstallProcessTree,runProcessWithActivityTimeout,installIdleTimeoutForPlatform,buildCuaInstallerProxyEnv,listComputerWindowsForAtMention,resetAtMentionWindowCacheForTests,getComputerDriverStatus,installComputerDriver,extractDriverSemver,compareSemver,pickLatestCuaDriverRelease,pickLatestCuaDriverVersion,resolveCuaDriverHostArch,getCuaDriverReleaseAssetName,resetComputerDriverUpdateStateForTests,checkComputerDriverUpdate,extractCurlOutputPath,matchAssetSizeByFilename,updateComputerDriver,getComputerDriverAppIcon,resetComputerDriverAppIconCacheForTests,cancelComputerDriverPermissionGrant,grantComputerDriverPermissions,callComputerDriverTool,cleanupComputerDriverSession,cleanupAllComputerDriverSessions,getComputerMcpDeps}=runtime;
export type {ComputerDriverInstallResult,ComputerDriverUpdateCheck,ComputerDriverPermissionGrantResult,ComputerMcpDepsOptions,ActivityTimeoutOptions,CuaDriverReleaseAsset,ComputerDriverUpdateProgress} from '@cindy/app-runtime/computerRuntime';
