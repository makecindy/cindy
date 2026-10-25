import {createBotAutonomyHostData} from '@cindy/app-runtime/botAutonomyHostData';
import {getDbClient} from '../localDb/client/current.js';
import {readTaskResponsibilities,responsibleSessionIds} from '../maker-ipc/botTaskResponsibility.js';
import {isCompanionShadowed} from '../companion-cloud/homes.js';
export const {readLocalSessionMetas,readInterruptedSessionMetas,readBotDirectory,readTaskOwnership,toRemoteTargets}=createBotAutonomyHostData({getDbClient:()=>getDbClient(),isCompanionShadowed:id=>isCompanionShadowed(id),readTaskResponsibilities:(...args)=>readTaskResponsibilities(...args),responsibleSessionIds:(...args)=>responsibleSessionIds(...args)});
