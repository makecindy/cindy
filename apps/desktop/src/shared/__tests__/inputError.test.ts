import { describe, expect, it } from 'vitest';

import {
  PI_IMAGE_CAPABILITY_REFRESH_FAILED_MARKER,
  PI_IMAGE_INPUT_UNSUPPORTED_MARKER,
  isPiImageCapabilityRefreshFailedError,
  isPiImageInputUnsupportedError,
} from '../inputError';

describe('isPiImageInputUnsupportedError', () => {
  it('recognizes both the structured code and the wire-safe marker', () => {
    expect(
      isPiImageInputUnsupportedError(
        Object.assign(new Error('disabled'), { code: 'PI_IMAGE_INPUT_UNSUPPORTED' }),
      ),
    ).toBe(true);
    expect(isPiImageInputUnsupportedError(`${PI_IMAGE_INPUT_UNSUPPORTED_MARKER} disabled`)).toBe(
      true,
    );
  });

  it('does not classify unrelated image errors', () => {
    expect(isPiImageInputUnsupportedError('image omitted: model does not support images')).toBe(
      false,
    );
  });
});

describe('isPiImageCapabilityRefreshFailedError', () => {
  it('recognizes both the structured code and the wire-safe marker', () => {
    expect(
      isPiImageCapabilityRefreshFailedError(
        Object.assign(new Error('pending'), { code: 'PI_IMAGE_CAPABILITY_REFRESH_FAILED' }),
      ),
    ).toBe(true);
    expect(
      isPiImageCapabilityRefreshFailedError(`${PI_IMAGE_CAPABILITY_REFRESH_FAILED_MARKER} pending`),
    ).toBe(true);
  });

  it('does not confuse the retryable refresh failure with the unsupported verdict', () => {
    // 两个码在 UI 上是两种处置：前者可重试，后者要用户换模型/开能力。混判会给出错误指引。
    expect(
      isPiImageCapabilityRefreshFailedError(`${PI_IMAGE_INPUT_UNSUPPORTED_MARKER} disabled`),
    ).toBe(false);
    expect(
      isPiImageInputUnsupportedError(`${PI_IMAGE_CAPABILITY_REFRESH_FAILED_MARKER} pending`),
    ).toBe(false);
  });
});
