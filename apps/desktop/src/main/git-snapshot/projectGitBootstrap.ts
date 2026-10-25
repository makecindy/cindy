import {createProjectGitBootstrap} from '@cindy/app-runtime/projectGitBootstrap';
import {detectCwd} from '../worktree/WorktreeManager';
import {gitExec} from '../worktree/gitExec';
import {createLogger} from '../logger';
import {createSnapshotDetailed} from './gitSnapshotService';
const runtime=createProjectGitBootstrap({createLogger,gitExec:(...args)=>gitExec(...args),detectCwd:(...args)=>detectCwd(...args),createSnapshotDetailed:(...args)=>createSnapshotDetailed(...args)});
export const {shouldBootstrapProjectGit,ensureProjectGitInitialized} = runtime;
export {type ProjectGitBootstrapStatus,type ProjectGitBootstrapRequest,type ProjectGitBootstrapResult} from '@cindy/app-runtime/projectGitBootstrap';
