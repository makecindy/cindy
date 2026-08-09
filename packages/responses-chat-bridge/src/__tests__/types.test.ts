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

const LITELLM_IMAGE_ERROR_BODY = JSON.stringify({
  error: {
    message:
      'Failed to deserialize the JSON body into the target type: messages[63]: unknown variant `image_url`, expected `text`',
    type: 'invalid_request_error',
    code: 'invalid_request_error',
  },
});

function litellmGatewayError(body: string): string {
  return `litellm.BadRequestError: DeepseekException - ${body}`;
}

function litellmSdkError(body: string): string {
  return JSON.stringify({
    error: {
      message: litellmGatewayError(body),
      type: null,
      param: null,
      code: '400',
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

  it('accepts the bridge message rendered by the pinned Codex runtime', () => {
    const message =
      "Responses feature is not supported by the Chat Completions bridge: input content part 'input_image'";

    expect(isUnsupportedResponsesImageErrorPayload(codexUnexpectedResponse(message))).toBe(true);
  });

  it('accepts a Codex error that retains the serialized bridge response body', () => {
    const payload = unsupportedFeaturePayload("input content part 'input_image'");

    expect(isUnsupportedResponsesImageErrorPayload(codexUnexpectedResponse(payload))).toBe(true);
  });

  it.each([
    litellmGatewayError(LITELLM_IMAGE_ERROR_BODY),
    `API Error: 400 litellm.BadRequestError: AzureException BadRequestError - ${LITELLM_IMAGE_ERROR_BODY}`,
    litellmSdkError(LITELLM_IMAGE_ERROR_BODY),
  ])('accepts LiteLLM image deserialization rejection: %s', (payload) => {
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it.each([
    unsupportedFeaturePayload("input content part 'input_file'"),
    unsupportedFeaturePayload("input content part 'input_image'", 'invalid_request'),
    JSON.stringify({ error: { code: 'unsupported_feature', message: 'input_image' } }),
    litellmGatewayError(
      JSON.stringify({
        error: {
          message: 'Failed to deserialize the JSON body for the request',
        },
      }),
    ),
    litellmGatewayError(
      JSON.stringify({
        error: { message: 'Failed to parse image dimensions' },
      }),
    ),
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
  it('extracts the provider message and adds the stable marker', () => {
    expect(litellmImageErrorPayload(litellmGatewayError(LITELLM_IMAGE_ERROR_BODY))).toBe(
      '[MODEL_IMAGE_INPUT_UNSUPPORTED] Failed to deserialize the JSON body into the target type: ' +
        'messages[63]: unknown variant `image_url`, expected `text`',
    );
  });

  it('accepts the SDK-wrapped prefix and returns null for unrelated payloads', () => {
    expect(
      litellmImageErrorPayload(
        `API Error: 400 litellm.BadRequestError: AzureException BadRequestError - ${LITELLM_IMAGE_ERROR_BODY}`,
      ),
    ).toContain('[MODEL_IMAGE_INPUT_UNSUPPORTED]');
    expect(litellmImageErrorPayload(litellmSdkError(LITELLM_IMAGE_ERROR_BODY))).toContain(
      '[MODEL_IMAGE_INPUT_UNSUPPORTED]',
    );
    expect(litellmImageErrorPayload(LITELLM_IMAGE_ERROR_BODY)).toBeNull();
    expect(litellmImageErrorPayload(null)).toBeNull();
    expect(litellmImageErrorPayload('')).toBeNull();
  });
});
