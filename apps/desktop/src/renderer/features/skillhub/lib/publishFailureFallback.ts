import { isSkillhubPublishErrorCode } from '../../../../shared/skillhubPublishErrors';

export function normalizePublishErrorCode(errorCode: unknown): SkillhubPublishErrorCode {
  return isSkillhubPublishErrorCode(errorCode)
    ? errorCode
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
