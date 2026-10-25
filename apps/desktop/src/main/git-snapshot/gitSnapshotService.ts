import {createGitSnapshotService} from '@cindy/app-runtime/gitSnapshotService';
import {createLogger} from '../logger';
import {gitExec} from '../worktree/gitExec';
import {isolatedGitExec,snapshotGitIsolationArgs} from './isolatedGitExec';
import {buildSnapshotFilePlan,resolveSnapshotGitPath} from './snapshotFileFilter';
import {readSavepointTip,savepointRefForSession} from './savepointRefs';
const runtime=createGitSnapshotService({createLogger,gitExec:(...args)=>gitExec(...args),isolatedGitExec:(...args)=>isolatedGitExec(...args),snapshotGitIsolationArgs:(...args)=>snapshotGitIsolationArgs(...args),buildSnapshotFilePlan:(...args)=>buildSnapshotFilePlan(...args),resolveSnapshotGitPath:(...args)=>resolveSnapshotGitPath(...args),readSavepointTip:(...args)=>readSavepointTip(...args),savepointRefForSession:(...args)=>savepointRefForSession(...args)});
export const {getHead,getCurrentBranch,createSnapshot,createSnapshotMarker,createSnapshotDetailed,listSnapshots,createShadowSavepoint,createShadowMarker,listShadowSavepoints,writeWorktreeTreeForPaths,listUnprotectedPaths,chunkPathspecArgs,withPathspecFile} = runtime;
export {type SnapshotBlockedGitStateReason,type SnapshotBlockedGitState,type StagedDiff,type SnapshotLabelFactory,type SnapshotUnsafeFilePolicy,type CreateSnapshotInput,type CreateSnapshotMarkerInput,type CreateSnapshotDetailedResult,type SnapshotEntry,type ListSnapshotsOptions,SnapshotUnsafeFilesError,SnapshotBlockedByGitStateError,type CreateShadowSavepointInput,type SkippedFileFingerprint,type ShadowSavepointResult,type CreateShadowMarkerInput,type ListShadowSavepointsResult} from '@cindy/app-runtime/gitSnapshotService';
