/** Local-device setting; the folder is never synchronized to other computers. */
export interface TaskExportDirectoryState {
  /** null = off: Agent task exports ask for a location in the save dialog. */
  path: string | null;
  exists: boolean;
  /** The settings file exists but cannot be read; exports fail until the owner resets or chooses again. */
  unreadable: boolean;
}
