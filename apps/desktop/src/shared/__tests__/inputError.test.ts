import { describe, expect, it } from 'vitest';

import { PI_IMAGE_INPUT_UNSUPPORTED_MARKER, isPiImageInputUnsupportedError } from '../inputError';

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
