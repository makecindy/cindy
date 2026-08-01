import { describe, expect, it } from 'vitest';

import {
  isUnsupportedResponsesImageErrorPayload,
  UnsupportedResponsesFeatureError,
} from '../types.js';

function unsupportedFeaturePayload(feature: string, code = 'unsupported_feature'): string {
  return JSON.stringify({
    error: {
      type: 'invalid_request_error',
      code,
      message: new UnsupportedResponsesFeatureError(feature).message,
    },
  });
}

describe('isUnsupportedResponsesImageErrorPayload', () => {
  it.each([
    "input content part 'input_image'",
    "input content part 'image_url'",
    "input content part 'image'",
    'input_image',
    'input_image.file_id',
  ])('accepts current and compatible image feature shapes: %s', (feature) => {
    expect(isUnsupportedResponsesImageErrorPayload(unsupportedFeaturePayload(feature))).toBe(true);
  });

  it.each([
    unsupportedFeaturePayload("input content part 'input_file'"),
    unsupportedFeaturePayload("input content part 'input_image'", 'invalid_request'),
    JSON.stringify({ error: { code: 'unsupported_feature', message: 'input_image' } }),
    'not json',
    '',
  ])('rejects unrelated or malformed payloads: %s', (payload) => {
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(false);
  });
});
