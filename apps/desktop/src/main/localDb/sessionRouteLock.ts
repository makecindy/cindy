import {createSessionRouteLock} from '@cindy/app-runtime/sessionRouteLock';
export type * from '@cindy/app-runtime/sessionRouteLock';

export const {setSessionRouteLockImplementation, withSessionRouteLock, withSessionRouteLocks}=createSessionRouteLock();
