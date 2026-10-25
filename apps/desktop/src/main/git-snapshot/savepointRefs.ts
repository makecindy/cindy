import {createSavepointRefs} from '@cindy/app-runtime/savepointRefs';
import {gitExec} from '../worktree/gitExec';
import {createLogger} from '../logger';
const runtime=createSavepointRefs({gitExec:(...args)=>gitExec(...args),createLogger});
export const {SAVEPOINT_REF_NAMESPACE,savepointRefForSession,readSavepointTip,deleteSavepointRef,listSavepointRefs} = runtime;
export {InvalidSavepointSessionIdError} from '@cindy/app-runtime/savepointRefs';
