import { isCodexResumeNotReadyProjectionError } from '@cindy/maker-shared/agent-input-projection';

export const PI_IMAGE_INPUT_UNSUPPORTED_MARKER = '[PI_IMAGE_INPUT_UNSUPPORTED]';
export const MODEL_IMAGE_INPUT_UNSUPPORTED_MARKER = '[MODEL_IMAGE_INPUT_UNSUPPORTED]';

export function isPiImageInputUnsupportedProjectionError(error: string): boolean {
  return error.includes(PI_IMAGE_INPUT_UNSUPPORTED_MARKER);
}

export function isModelImageInputUnsupportedProjectionError(error: string): boolean {
  return error.includes(MODEL_IMAGE_INPUT_UNSUPPORTED_MARKER);
}

export type InputProjectionErrorI18nKey =
  | 'message.queue.codexResumeNotReady'
  | 'message.queue.modelImageInputUnsupported'
  | 'message.queue.piImageInputUnsupported';

/** Resolve stable host markers without freezing the current Mobile locale. */
export function inputProjectionErrorI18nKey(error: string): InputProjectionErrorI18nKey | null {
  if (isCodexResumeNotReadyProjectionError(error)) return 'message.queue.codexResumeNotReady';
  if (isModelImageInputUnsupportedProjectionError(error)) {
    return 'message.queue.modelImageInputUnsupported';
  }
  if (isPiImageInputUnsupportedProjectionError(error)) return 'message.queue.piImageInputUnsupported';
  return null;
}
