/** Local-device setting; the folder is never synchronized to other computers. */
export interface TaskExportDirectoryState {
  /** null = off: Agent task exports ask for a location in the save dialog. */
  path: string | null;
  exists: boolean;
}
