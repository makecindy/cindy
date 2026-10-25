import {createBotTaskResponsibility} from '@cindy/app-runtime/botTaskResponsibility';
import {signalBotAutonomyBotsChanged} from '../bot-autonomy/botsChangedSignal.js';
export type {TaskResponsibilities,TaskResponsibilityScope} from '@cindy/app-runtime/botTaskResponsibility';
export const {readTaskResponsibilities,responsibleSessionIds,setTaskResponsibility,collectTaskResponsibilityScopes}=createBotTaskResponsibility(()=>signalBotAutonomyBotsChanged());
