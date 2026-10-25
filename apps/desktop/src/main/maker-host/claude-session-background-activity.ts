import {createLogger} from '../logger.js';
import {createClaudeSessionBackgroundActivity} from '@cindy/app-runtime/claude-session-background-activity';
export type * from '@cindy/app-runtime/claude-session-background-activity';
export const {setClaudeBackgroundActivityBroadcaster,recordClaudeApiActivity,noteClaudeSessionTurnState,clearClaudeSessionBackgroundActivity,getClaudeSessionBackgroundActivity,listActiveClaudeBackgroundActivitySessions,resetClaudeBackgroundActivityForTests,createClaudeSessionActivityResponseObserver}=createClaudeSessionBackgroundActivity(createLogger);
