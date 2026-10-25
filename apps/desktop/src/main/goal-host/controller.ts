import {GoalController as SharedGoalController} from '@cindy/app-runtime/goal/controller';
import type {GoalControllerDeps} from './types';
import {agentHandoffPending} from '../maker-ipc/agentHandoffPendingSingleton';
import {onUiSessionIntervention} from '../maker-ipc/uiContinuationSignal';
export * from '@cindy/app-runtime/goal/controller';
export class GoalController extends SharedGoalController {
 constructor(deps:GoalControllerDeps){super(deps,{agentHandoffPending,onUiSessionIntervention:(...args)=>onUiSessionIntervention(...args)});}
}
