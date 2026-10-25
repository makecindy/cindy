import {createCindyMakeAttention} from '@cindy/runtime-db/cindyMakeAttention';
export type * from '@cindy/runtime-db/cindyMakeAttention';
import {getDbClient} from './client/current.js';
export const {listCindyMakePendingFailureSessionIds}=createCindyMakeAttention(getDbClient);
