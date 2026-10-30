export { REAL_MANAGED_PROFILE } from '../browser-managed-config.js';
export {
  RealProfileError,
  isRealProfileError,
  type ChromiumKind,
  type InstalledChromium,
  type RealProfileErrorCode,
  type RealProfileStatusHint,
  type SnapshotResult,
} from './types.js';
export {
  detectDefaultHandlerFromOs,
  listInstalledChromium,
  parseDefaultHandler,
  resolveSourceBrowser,
  resolveSourceBrowserFromOs,
  userDataDirFor,
} from './source.js';
export {
  assertManagedBrowserStopped,
  createBrowserProfileLifecycleQueue,
  managedConfigPatchBeforeStop,
  stopManagedBrowserForProfile,
  wrapRuntimeWithProfileLifecycleQueue,
} from './runtime-stop.js';
export {
  cleanupCopiedLoginsThen,
  cleanupRealProfileSnapshots,
  isolatedProfileDestDir,
  lastUsedProfileName,
  probeOsSourceProfileReadAccess,
  probeSourceProfileReadAccess,
  profileIsLocked,
  profileUsesAppBoundEncryption,
  pruneExtraChromeProfiles,
  pruneNonAuthProfileState,
  readCopiedLoginsCdpPort,
  realProfileDestDir,
  realProfileProfileDir,
  rememberCopiedLoginsCdpPort,
  rewriteLocalStateForManagedDefault,
  snapshotRealProfile,
} from './snapshot.js';
export {
  activeManagedProfileName,
  annotateStatusData,
  FOREIGN_AGENT_BROWSER_ERROR,
  isOurManagedBrowser,
  isOwnLiveManagedBrowser,
  wrapRuntimeWithRealProfile,
  withActiveBrowserProfile,
  type RealProfileLaunchDeps,
} from './launch.js';
