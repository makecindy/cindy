import {createSessionQueries} from '@cindy/app-runtime/sessionQueries';
export type * from '@cindy/app-runtime/sessionQueries';
import {sessionToCamel} from './mapper';
export const {flattenSessionReadRow, projectSessionReadResult, selectSessionsByIds, selectSessionWithCount, selectSessionListRows}=createSessionQueries(sessionToCamel);
