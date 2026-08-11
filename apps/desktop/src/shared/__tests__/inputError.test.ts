import { describe, expect, it } from 'vitest';

import {
  MODEL_IMAGE_INPUT_UNSUPPORTED_MARKER,
  PI_IMAGE_INPUT_UNSUPPORTED_MARKER,
  isModelImageInputUnsupportedError,
  isPiImageInputUnsupportedError,
} from '../inputError';

describe('isModelImageInputUnsupportedError', () => {
  it('recognizes the generic structured code and wire-safe marker without matching Pi', () => {
    expect(
      isModelImageInputUnsupportedError(
        Object.assign(new Error('disabled'), { code: 'MODEL_IMAGE_INPUT_UNSUPPORTED' }),
      ),
    ).toBe(true);
    expect(
      isModelImageInputUnsupportedError(`${MODEL_IMAGE_INPUT_UNSUPPORTED_MARKER} disabled`),
    ).toBe(true);
    expect(isModelImageInputUnsupportedError(PI_IMAGE_INPUT_UNSUPPORTED_MARKER)).toBe(false);
  });
});

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
