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
export { assertManagedBrowserStopped } from './runtime-stop.js';
export {
  cleanupCopiedLoginsThen,
  cleanupRealProfileSnapshots,
  isolatedProfileDestDir,
  lastUsedProfileName,
  probeOsSourceProfileReadAccess,
  probeSourceProfileReadAccess,
  profileIsLocked,
  pruneExtraChromeProfiles,
  realProfileDestDir,
  realProfileProfileDir,
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
