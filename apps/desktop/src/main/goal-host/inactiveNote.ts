import {createGoalInactiveNote} from '@cindy/app-runtime/goal/inactiveNote';
import {getDbClient} from '../localDb/client/current.js';
import {latestNonEmptyMessageText} from '../localDb/latestMessageText.js';
export * from '@cindy/im-runtime/goalInactiveNote';
export const {peekGoalInactiveNote}=createGoalInactiveNote({getDbClient:()=>getDbClient(),latestNonEmptyMessageText:(...args)=>latestNonEmptyMessageText(...args)});
