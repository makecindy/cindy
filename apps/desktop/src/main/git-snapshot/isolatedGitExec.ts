import {createSnapshotGitIsolation} from '@cindy/app-runtime/isolatedGitExec';
import {gitExec} from '../worktree/gitExec';
const runtime=createSnapshotGitIsolation({gitExec:(...args)=>gitExec(...args)});
export const {snapshotGitIsolationArgs,isolatedGitExec} = runtime;
export {SnapshotGitIsolationError} from '@cindy/app-runtime/isolatedGitExec';
