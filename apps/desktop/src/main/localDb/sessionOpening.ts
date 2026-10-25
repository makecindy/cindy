import {createSessionOpening} from '@cindy/app-runtime/sessionOpening';
import {sessionCreateToRow} from './mapper.js';
import {getDbClient,getCurrentDbClientSnapshot} from './client/current.js';
import {ensureDialogueWorkspaceDir} from './dialogueWorkspace.js';
import {ensureProjectGitInitialized} from '../git-snapshot/projectGitBootstrap.js';
import {readGitSafetySettings} from '../maker-host/git-safety-settings-store.js';
export type * from '@cindy/app-runtime/sessionOpening';
export const {setSessionOpeningModelAdmission, ensureOpenedProjectGit, openSession}=createSessionOpening({sessionCreateToRow:(...args)=>sessionCreateToRow(...args),getDbClient:()=>getDbClient(),getCurrentDbClientSnapshot:()=>getCurrentDbClientSnapshot(),ensureDialogueWorkspaceDir:(...args)=>ensureDialogueWorkspaceDir(...args),ensureProjectGitInitialized:(...args)=>ensureProjectGitInitialized(...args),readGitSafetySettings:()=>readGitSafetySettings()});
