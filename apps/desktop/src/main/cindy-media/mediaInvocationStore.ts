import {getDbClient} from '../localDb/client/current.js';
import {createMediaInvocationStore} from '@cindy/app-runtime/media/mediaInvocationStore';
export type {MediaInvocationState,StoredMediaInvocation} from '@cindy/app-runtime/media/mediaInvocationStore';
export const {recoverInterruptedMediaInvocations,pruneMediaInvocations,countMediaInvocations,createMediaInvocation,getMediaInvocation,transitionMediaInvocation}=createMediaInvocationStore(getDbClient);
