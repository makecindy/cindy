import { describe, expect, it } from 'vitest';

import { isPiImageInputUnsupportedProjectionError } from '@/session/inputProjectionError';

describe('isPiImageInputUnsupportedProjectionError', () => {
  it('recognizes the Desktop projection marker without depending on host locale', () => {
    expect(
      isPiImageInputUnsupportedProjectionError(
        '[PI_IMAGE_INPUT_UNSUPPORTED] image input disabled',
      ),
    ).toBe(true);
  });

  it('leaves ordinary remote errors untouched', () => {
    expect(isPiImageInputUnsupportedProjectionError('provider unavailable')).toBe(false);
  });
});
