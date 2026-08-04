import { describe, expect, it } from 'vitest';
import { CODEX_RESUME_NOT_READY_WIRE_MESSAGE } from '@cindy/maker-shared/agent-input-projection';

import {
  inputProjectionErrorI18nKey,
  isPiImageInputUnsupportedProjectionError,
} from '@/session/inputProjectionError';

describe('isPiImageInputUnsupportedProjectionError', () => {
  it('recognizes the Desktop projection marker without depending on host locale', () => {
    const error = '[PI_IMAGE_INPUT_UNSUPPORTED] image input disabled';
    expect(isPiImageInputUnsupportedProjectionError(error)).toBe(true);
    expect(inputProjectionErrorI18nKey(error)).toBe('message.queue.piImageInputUnsupported');
  });

  it('leaves ordinary remote errors untouched', () => {
    expect(isPiImageInputUnsupportedProjectionError('provider unavailable')).toBe(false);
  });

  it('maps the shared Codex resume marker to a locale key without exposing host diagnostics', () => {
    expect(
      inputProjectionErrorI18nKey(
        `LAZY_CREATE_FAILED: ${CODEX_RESUME_NOT_READY_WIRE_MESSAGE}`,
      ),
    ).toBe('message.queue.codexResumeNotReady');
    expect(
      inputProjectionErrorI18nKey(
        `[CODEX_FORK_STATE_UNAVAILABLE] ${CODEX_RESUME_NOT_READY_WIRE_MESSAGE}`,
      ),
    ).toBe('message.queue.codexResumeNotReady');
    expect(inputProjectionErrorI18nKey('provider unavailable')).toBeNull();
  });
});
