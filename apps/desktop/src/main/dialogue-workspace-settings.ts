import {createDialogueWorkspaceSettings} from '@cindy/app-runtime/dialogueWorkspaceSettings';
import {activeOwnerScopeKey,ownerScopedUserDataPath} from './appSessionState.js';
import {createLogger} from './logger.js';
const runtime=createDialogueWorkspaceSettings({activeOwnerScopeKey:()=>activeOwnerScopeKey(),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),createLogger});
export const {readDialogueWorkspaceSettings,dialogueWorkspaceRoots,writeDialogueWorkspaceDirectory}=runtime;
