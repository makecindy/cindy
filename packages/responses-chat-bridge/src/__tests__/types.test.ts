import { describe, expect, it } from 'vitest';

import {
  isUnsupportedResponsesImageErrorPayload,
  litellmImageErrorPayload,
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

function codexUnexpectedResponse(messageOrBody: string): string {
  return `unexpected status 400 Bad Request: ${messageOrBody}, url: http://127.0.0.1/v1/responses`;
}

const LITELLM_UPSTREAM_MESSAGE =
  '{"error":{"message":"Failed to deserialize the JSON body into the target type: ' +
  'messages[63]: unknown variant `image_url`, expected `text` at line 1 column 336145",' +
  '"type":"invalid_request_error","param":null,"code":"invalid_request_error"}}';

function litellmGatewayError(payload: string): string {
  return `litellm.BadRequestError: DeepseekException - ${payload}`;
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

  it('accepts the bridge message rendered by the pinned Codex runtime', () => {
    const message =
      "Responses feature is not supported by the Chat Completions bridge: input content part 'input_image'";

    expect(isUnsupportedResponsesImageErrorPayload(codexUnexpectedResponse(message))).toBe(true);
  });

  it('accepts a Codex error that retains the serialized bridge response body', () => {
    const payload = unsupportedFeaturePayload("input content part 'input_image'");

    expect(isUnsupportedResponsesImageErrorPayload(codexUnexpectedResponse(payload))).toBe(true);
  });

  it('accepts a litellm gateway rejection for a text-only upstream provider', () => {
    expect(isUnsupportedResponsesImageErrorPayload(litellmGatewayError(LITELLM_UPSTREAM_MESSAGE))).toBe(
      true,
    );
    expect(isUnsupportedResponsesImageErrorPayload(litellmGatewayError('raw image_url error'))).toBe(
      true,
    );
  });

  it.each([
    unsupportedFeaturePayload("input content part 'input_file'"),
    unsupportedFeaturePayload("input content part 'input_image'", 'invalid_request'),
    JSON.stringify({ error: { code: 'unsupported_feature', message: 'input_image' } }),
    codexUnexpectedResponse(
      "Responses feature is not supported by the Chat Completions bridge: input content part 'input_file'",
    ),
    'unexpected status 401 Unauthorized: Responses feature is not supported by the Chat Completions bridge: input_image',
    'not json',
    '',
  ])('rejects unrelated or malformed payloads: %s', (payload) => {
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(false);
  });
});

describe('litellmImageErrorPayload', () => {
  it('extracts the upstream provider error with the friendly marker from the gateway wrapper', () => {
    expect(litellmImageErrorPayload(litellmGatewayError(LITELLM_UPSTREAM_MESSAGE))).toBe(
      '[PI_IMAGE_INPUT_UNSUPPORTED] Failed to deserialize the JSON body into the target type: ' +
        'messages[63]: unknown variant `image_url`, expected `text` at line 1 column 336145',
    );
  });

  it('returns null for payloads without the gateway wrapper', () => {
    expect(litellmImageErrorPayload(LITELLM_UPSTREAM_MESSAGE)).toBeNull();
    expect(litellmImageErrorPayload(null)).toBeNull();
    expect(litellmImageErrorPayload('')).toBeNull();
  });
});
