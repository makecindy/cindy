/** Stable failure codes for the local HTML system-browser opener. */
export type BrowserFileOpenErrorCode =
  | 'INVALID_TARGET'
  | 'PATH_NOT_ALLOWED'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_NOT_FOUND'
  | 'OPEN_FAILED';

export interface BrowserFileOpenResult {
  success: boolean;
  error?: string;
  errorCode?: BrowserFileOpenErrorCode;
}
