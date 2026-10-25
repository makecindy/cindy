import {createSnapshotFileFilter} from '@cindy/app-runtime/snapshotFileFilter';
import {isolatedGitExec} from './isolatedGitExec';
const runtime=createSnapshotFileFilter({isolatedGitExec:(...args)=>isolatedGitExec(...args)});
export const {resolveSnapshotGitPath,detectSensitiveSnapshotPath,parseStatusPorcelainZ,buildSnapshotFilePlanFromEntries,buildSnapshotFilePlan} = runtime;
export {type SnapshotSkippedFileReason,type SnapshotSkippedFile,type SnapshotIncludedFile,type SnapshotFileFilterOptions,type SnapshotStatusEntry,type SnapshotFilePlan} from '@cindy/app-runtime/snapshotFileFilter';
