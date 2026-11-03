/** Local-device setting; paths are never synchronized to other computers. */
export interface ProjectsRootState {
  path: string;
  /** setting = the user's choice; inferred = shared parent of registered projects; default = ~/Projects. */
  source: 'setting' | 'inferred' | 'default';
  exists: boolean;
}

export interface PreparedProjectFromTask {
  suggestedName: string;
  root: ProjectsRootState;
  /** True when the task's managed dialogue files will move into the new folder. */
  movesFiles: boolean;
}

export interface CreateProjectFromTaskInput {
  sessionId: string;
  name: string;
  /** The suggested root, or a folder returned by createProjectFromTask.chooseParent. */
  parentDir: string;
  /** Save parentDir as the location for future new projects. */
  remember: boolean;
}

export interface CreateProjectFromTaskResult {
  workingDir: string;
  movedEntries: number;
}
