/** Local picker failures; directory paths never travel in the error payload. */
export const WRITABLE_DIRECTORY_GRANT_ERROR_CODES = [
  'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
  'WRITABLE_DIRECTORY_TARGET_CHANGED',
  'WRITABLE_DIRECTORY_UNAVAILABLE',
] as const;

export type WritableDirectoryGrantErrorCode =
  (typeof WRITABLE_DIRECTORY_GRANT_ERROR_CODES)[number];

export function isWritableDirectoryGrantErrorCode(
  code: unknown,
): code is WritableDirectoryGrantErrorCode {
  return WRITABLE_DIRECTORY_GRANT_ERROR_CODES.some((value) => value === code);
}
