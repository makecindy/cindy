import type { IpcErrorCode } from './ipc-errors';

/** Stable failure codes for the local HTML system-browser opener. */
export type BrowserFileOpenErrorCode = Extract<IpcErrorCode, `BROWSER_FILE_${string}`>;

export type BrowserFileOpenResult =
  | { success: true }
  | { success: false; error: string; errorCode: BrowserFileOpenErrorCode };
