import {getDbClient} from '../localDb/client/current.js';
import {createBotWorkbenchTranscripts} from '@cindy/app-runtime/botWorkbenchTranscripts';
export const {WORKBENCH_TRANSCRIPT_MAX_CHARS,boundTranscript,readSessionTranscript,lastExchange,readSessionLastExchange}=createBotWorkbenchTranscripts(()=>getDbClient());
