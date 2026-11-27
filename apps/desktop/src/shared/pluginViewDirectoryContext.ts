export const SET_PLUGIN_VIEW_DIRECTORY_CONTEXT = 'ghosts:view-directory-context';
export const PLUGIN_VIEW_DIRECTORY_CONTEXT = 'ghost-page:directory-context';

export type PluginViewDirectorySource =
  | { kind: 'task'; sessionId: string }
  | { kind: 'project'; projectDir: string };

export interface PluginViewDirectoryContext {
  /** The directory selected for the project, when known. */
  projectDir: string | null;
  /** The local task's effective directory, including a Git worktree when used. */
  workingDir: string | null;
}
