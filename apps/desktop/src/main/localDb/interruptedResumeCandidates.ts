import {createInterruptedResumeCandidates} from '@cindy/app-runtime/interruptedResumeCandidates';
export type * from '@cindy/app-runtime/interruptedResumeCandidates';
import {getDbClient} from './client/current';
import {listInterruptedPendingRows} from './sessionActiveTurn';
export const {listInterruptedResumeCandidateRows}=createInterruptedResumeCandidates({getDbClient,listInterruptedPendingRows});
