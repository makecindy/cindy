import {app} from 'electron';
import {getDbClient} from '../localDb/client/current.js';
import {ownerScopedUserDataPath} from '../appSessionState.js';
import {createBotWorkspaceRuntime} from '@cindy/app-runtime/botWorkspaceRuntime';
export {BotPlanWorkDirUnavailableError} from '@cindy/app-runtime/botWorkspaceRuntime';
export type {BotWorkspaceRuntimeDeps} from '@cindy/app-runtime/botWorkspaceRuntime';
export const {prepareBotWorkspaceRuntime} = createBotWorkspaceRuntime({
  getDbClient, ownerScopedUserDataPath, legacyUserDataPath: () => app.getPath('userData'),
});
