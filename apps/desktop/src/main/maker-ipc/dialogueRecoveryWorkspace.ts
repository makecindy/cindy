import {createDialogueRecoveryWorkspace} from '@cindy/app-runtime/dialogueRecoveryWorkspace';
import {ownerScopedUserDataPath} from '../appSessionState.js';
import {dialogueWorkspaceRoots} from '../dialogue-workspace-settings.js';
export const {requiredDialogueRecoveryRoot,findDialogueRecoveryWorkspace,allocateDialogueRecoveryWorkspace}=createDialogueRecoveryWorkspace({ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),dialogueWorkspaceRoots:()=>dialogueWorkspaceRoots()});
