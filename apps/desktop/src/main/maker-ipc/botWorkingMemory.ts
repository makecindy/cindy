import {createBotWorkingMemory} from '@cindy/app-runtime/botWorkingMemory';
import {getDbClient} from '../localDb/client/current.js';
export * from '@cindy/app-runtime/botWorkingMemory';
export const {resolveCanonicalBotIdForSession,listWithdrawnSourceMessageIds,readWorkingMemoryNoteForSession,pruneWorkingMemoryForSession,pruneWithdrawnWorkingMemoryForSession,isWorkingMemoryFreshForSession}=createBotWorkingMemory({getDbClient:()=>getDbClient()});
