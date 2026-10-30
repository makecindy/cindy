/** Publish failures shared by the main process, IPC fallback and renderer. */
export const SKILLHUB_PUBLISH_ERROR_CODES = [
  'NAME_TAKEN', 'SKILL_DELETED', 'SKILL_UNPUBLISHED', 'INVALID_DEPT', 'INVALID_NAME',
  'CATEGORY_REQUIRED', 'MANIFEST_INVALID', 'INVALID_PARAMS', 'SKILL_FILE_TOO_LARGE',
  'VERSION_RACE', 'CHECKSUM_MISMATCH', 'NOT_AUTHOR', 'PERMISSION_DENIED', 'AUTH_REQUIRED',
  'PACK_FAILED', 'OSS_PUT_FAILED', 'OSS_PUT_EXPIRED', 'OSS_OBJECT_NOT_FOUND',
  'API_KEY_MISSING', 'CANCELLED', 'SKILL_HUB_READ_ONLY', 'INVALID_VISIBILITY',
  'NETWORK_ERROR', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'PUBLISH_BUSY',
  'REQUEST_REJECTED', 'INTERNAL',
] as const;

export type SkillhubPublishErrorCode = typeof SKILLHUB_PUBLISH_ERROR_CODES[number];

export function isSkillhubPublishErrorCode(code: unknown): code is SkillhubPublishErrorCode {
  return typeof code === 'string' && (SKILLHUB_PUBLISH_ERROR_CODES as readonly string[]).includes(code);
}

/** Older servers used FORBIDDEN for deletion; keep their explicit reason actionable. */
export function serverPublishErrorCode(code: string, message = '', statusCode?: number): SkillhubPublishErrorCode {
  if (code === 'FORBIDDEN' && message === '已删除的 Skill 不能继续发布') return 'SKILL_DELETED';
  if (isSkillhubPublishErrorCode(code)) return code;
  if (['UNAUTHORIZED', 'TOKEN_EXPIRED', 'INVALID_TOKEN', 'ACCOUNT_UNAVAILABLE'].includes(code)) return 'AUTH_REQUIRED';
  if (code === 'FORBIDDEN') return 'PERMISSION_DENIED';
  if (code === 'UPLOAD_SESSION_EXPIRED') return 'OSS_PUT_EXPIRED';
  if (['STORAGE_UNAVAILABLE', 'CACHE_UNAVAILABLE', 'ORG_ROUTING_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY'].includes(code)) {
    return 'SERVICE_UNAVAILABLE';
  }
  if (code === 'INTERNAL_ERROR') return 'INTERNAL';
  if (statusCode === 401) return 'AUTH_REQUIRED';
  if (statusCode === 403) return 'PERMISSION_DENIED';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode === 413) return 'SKILL_FILE_TOO_LARGE';
  if (statusCode === 0) return 'NETWORK_ERROR';
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return 'REQUEST_REJECTED';
  return 'INTERNAL';
}

const PUBLIC_BUSINESS_ERROR_CODES: readonly SkillhubPublishErrorCode[] = [
  'NAME_TAKEN', 'SKILL_DELETED', 'SKILL_UNPUBLISHED', 'INVALID_DEPT', 'INVALID_NAME',
  'CATEGORY_REQUIRED', 'MANIFEST_INVALID', 'INVALID_PARAMS', 'SKILL_FILE_TOO_LARGE',
  'VERSION_RACE', 'CHECKSUM_MISMATCH',
  'INVALID_VISIBILITY', 'REQUEST_REJECTED',
];

/** Only deliberate business messages are user-facing; service/auth diagnostics use recovery copy. */
export function publishErrorDetail(code: SkillhubPublishErrorCode, message: unknown): string {
  if (!PUBLIC_BUSINESS_ERROR_CODES.includes(code)) return '';
  return typeof message === 'string' ? message.trim() : '';
}
