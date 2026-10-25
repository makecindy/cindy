import {createWorkingDirHistoryFilter} from '@cindy/app-runtime/workingDirHistoryFilter';
import {getDbClient} from './client/current.js';
import {dialogueWorkspaceRoots} from './dialogueWorkspace.js';
export const {normalizeHistoryWorkingDir,escapeLikePattern,managedDialogueRootLikePatterns,resolveStoredWorkingDirCandidates}=createWorkingDirHistoryFilter({getDbClient:()=>getDbClient(),dialogueWorkspaceRoots:()=>dialogueWorkspaceRoots()});
