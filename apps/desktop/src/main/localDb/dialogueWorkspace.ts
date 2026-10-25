import {createDialogueWorkspace} from '@cindy/app-runtime/dialogueWorkspace';
import {dialogueWorkspaceRoots,readDialogueWorkspaceSettings} from '../dialogue-workspace-settings.js';
export {dialogueWorkspaceRoots} from '../dialogue-workspace-settings.js';
export const {dialogueWorkspaceDayKey, dialogueWorkspaceRootDir, isManagedDialogueWorkspace, buildDialogueWorkspaceDir, ensureDialogueWorkspaceDir}=createDialogueWorkspace({dialogueWorkspaceRoots,readDialogueWorkspaceSettings});
