import { describe, expect, it } from 'vitest';

import {
  buildPublishFailureEvent,
  normalizePublishErrorCode,
  publishFailureMessage,
  shouldDispatchPublishResultFallback,
} from '../publishFailureFallback';

describe('publish failure fallback', () => {
  it('preserves known publish error codes', () => {
    expect(normalizePublishErrorCode('PACK_FAILED')).toBe('PACK_FAILED');
    expect(normalizePublishErrorCode('OSS_PUT_FAILED')).toBe('OSS_PUT_FAILED');
    expect(normalizePublishErrorCode('SKILL_DELETED')).toBe('SKILL_DELETED');
    expect(normalizePublishErrorCode('INVALID_PARAMS')).toBe('INVALID_PARAMS');
  });

  it('falls back unknown error codes to INTERNAL', () => {
    expect(normalizePublishErrorCode('SOMETHING_ELSE')).toBe('INTERNAL');
    expect(normalizePublishErrorCode(undefined)).toBe('INTERNAL');
  });

  it('builds a failed progress event from IPC fallback data', () => {
    expect(buildPublishFailureEvent('demo-skill', 'PACK_FAILED', new Error('zip timeout'))).toEqual({
      phase: 'failed',
      name: 'demo-skill',
      errorCode: 'PACK_FAILED',
      message: 'zip timeout',
    });
  });

  it('uses a stable generic message when IPC rejection has no message', () => {
    expect(publishFailureMessage(null)).toBe('Publish failed');
  });

  it('does not dispatch IPC result fallback after a failed progress event already handled the same publish', () => {
    expect(shouldDispatchPublishResultFallback('demo-skill', 'demo-skill', 'demo-skill')).toBe(false);
    expect(shouldDispatchPublishResultFallback('demo-skill', 'demo-skill', null)).toBe(true);
    expect(shouldDispatchPublishResultFallback('demo-skill', null, null)).toBe(false);
  });
});
