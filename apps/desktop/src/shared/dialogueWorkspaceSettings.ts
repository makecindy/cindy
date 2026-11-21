/** Local-device setting; paths are never synchronized to other computers. */
export interface DialogueWorkspaceSettingsState {
  directory: string;
  isCustomized: boolean;
}

export const DIALOGUE_WORKSPACE_UNAVAILABLE = 'DIALOGUE_WORKSPACE_UNAVAILABLE';
