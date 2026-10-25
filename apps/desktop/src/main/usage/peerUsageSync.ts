import {compareAppUpdateVersions} from '../updateVersionPolicy.js';
import {createLogger} from '../logger.js';
import {createPeerUsageRuntime as createRuntime} from '@cindy/app-runtime/peerUsageSync';
const runtime=createRuntime({compareAppUpdateVersions:(...args)=>compareAppUpdateVersions(...args),createLogger});
export const {mergeIncrementalRows,mayServeBackgroundRead,createPeerUsageSync,withPeerUsageAccessGate,peerUsageCacheFilePath,configurePeerUsageSync,getPeerUsageSync,readPeerUsageCacheFile,writePeerUsageCacheFile,__resetPeerUsageSyncForTesting}=runtime;
export type {UsageDeviceStatus,UsageDeviceSummary,PeerUsageSyncDeps,PeerUsageSnapshot,PeerUsageSync} from '@cindy/app-runtime/peerUsageSync';
