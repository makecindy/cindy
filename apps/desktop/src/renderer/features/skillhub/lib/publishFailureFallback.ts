const PUBLISH_ERROR_CODES = new Set<SkillhubPublishErrorCode>([
  'NAME_TAKEN',
  'INVALID_DEPT',
  'INVALID_NAME',
  'CATEGORY_REQUIRED',
  'MANIFEST_INVALID',
  'VERSION_RACE',
  'CHECKSUM_MISMATCH',
  'NOT_AUTHOR',
  'PACK_FAILED',
  'OSS_PUT_FAILED',
  'OSS_PUT_EXPIRED',
  'OSS_OBJECT_NOT_FOUND',
  'API_KEY_MISSING',
  'CANCELLED',
  'SKILL_HUB_READ_ONLY',
  'INVALID_VISIBILITY',
  'INTERNAL',
]);

export function normalizePublishErrorCode(errorCode: unknown): SkillhubPublishErrorCode {
  return typeof errorCode === 'string' && PUBLISH_ERROR_CODES.has(errorCode as SkillhubPublishErrorCode)
    ? errorCode as SkillhubPublishErrorCode
    : 'INTERNAL';
}

export function publishFailureMessage(message: unknown): string {
  if (message instanceof Error) return message.message;
  if (typeof message === 'string' && message.trim()) return message;
  return 'Publish failed';
}

export function buildPublishFailureEvent(
  name: string,
  errorCode: unknown,
  message: unknown,
): SkillhubPublishProgressEvent {
  return {
    phase: 'failed',
    name,
    errorCode: normalizePublishErrorCode(errorCode),
    message: publishFailureMessage(message),
  };
}

export function shouldDispatchPublishResultFallback(
  paramsName: string,
  activeName: string | null,
  failedProgressName: string | null,
): boolean {
  return activeName === paramsName && failedProgressName !== paramsName;
}
