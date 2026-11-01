import {createTaskActionHost} from '@cindy/app-runtime/taskActionHost';
export { teammateTurnPrincipal } from '@cindy/app-runtime/taskActionHost';
import {tryGetDbClient} from '../localDb/client/current.js';
import {isAppSessionBoundaryPending} from '../appSessionState.js';
import {authorizeGroupTool} from './botGroupToolAuthorization.js';
export const {createDesktopTaskActionAuthorizer}=createTaskActionHost({tryGetDbClient:()=>tryGetDbClient(),isAppSessionBoundaryPending,authorizeGroupTool:(...args)=>authorizeGroupTool(...args)});
