import { app, powerMonitor } from 'electron';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { resolveDesktopOutboundProxy } from '../maker-host/outbound-proxy-resolver.js';
import { createComputerRuntime } from './computer.js';
export type { ComputerDriverInstallResult, ComputerDriverUpdateCheck, ComputerDriverPermissionGrantResult, ComputerMcpDepsOptions, ActivityTimeoutOptions, CuaDriverReleaseAsset, ComputerDriverUpdateProgress } from './computer.js';
export const {
  getComputerDriverAppBundlePath,
  resetComputerDriverPermissionProbeCacheForTests,
  isComputerDriverPermissionProbePaused,
  pauseComputerDriverPermissionProbe,
  resumeComputerDriverPermissionProbe,
  isInstallLockHolderAlive,
  clearStaleCuaInstallLock,
  sampleInstallProcessTree,
  runProcessWithActivityTimeout,
  installIdleTimeoutForPlatform,
  buildCuaInstallerProxyEnv,
  listComputerWindowsForAtMention,
  resetAtMentionWindowCacheForTests,
  getComputerDriverStatus,
  installComputerDriver,
  extractDriverSemver,
  compareSemver,
  pickLatestCuaDriverRelease,
  pickLatestCuaDriverVersion,
  resolveCuaDriverHostArch,
  getCuaDriverReleaseAssetName,
  resetComputerDriverUpdateStateForTests,
  checkComputerDriverUpdate,
  extractCurlOutputPath,
  matchAssetSizeByFilename,
  updateComputerDriver,
  getComputerDriverAppIcon,
  resetComputerDriverAppIconCacheForTests,
  cancelComputerDriverPermissionGrant,
  grantComputerDriverPermissions,
  USER_INPUT_ACTIVE_WINDOW_MS,
  resetDesktopInputGuardStateForTests,
  seedDesktopScreenLocked,
  isDesktopScreenLocked,
  msSinceForeignDesktopInput,
  setPhysicalInputShielded,
  assertNoRecentUserInput,
  callComputerDriverTool,
  cleanupComputerDriverSession,
  cleanupAllComputerDriverSessions,
  getComputerMcpDeps
} = createComputerRuntime({
  // Preserve Desktop's lazy load of the native input handoff helpers.
  isSecureTarget: async target => (await import('../input-handoff/macDriver.js')).isSecureInputTarget(target),
  getPath: name => app.getPath(name),
  // Read Electron's monitor at the original call sites, not during module
  // assembly (it may not be available before app readiness).
  powerMonitor: {
    on: (event, listener) => event === 'lock-screen'
      ? powerMonitor.on('lock-screen', listener)
      : powerMonitor.on('unlock-screen', listener),
    removeListener: (event, listener) => event === 'lock-screen'
      ? powerMonitor.removeListener('lock-screen', listener)
      : powerMonitor.removeListener('unlock-screen', listener),
    getSystemIdleTime: () => powerMonitor.getSystemIdleTime(),
    getSystemIdleState: threshold => powerMonitor.getSystemIdleState(threshold),
  },
  outboundFetch,
  resolveOutboundProxy: resolveDesktopOutboundProxy,
});
