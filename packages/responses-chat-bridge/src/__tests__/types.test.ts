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

function codexUnexpectedResponse(messageOrBody: string): string {
  return `unexpected status 400 Bad Request: ${messageOrBody}, url: http://127.0.0.1/v1/responses`;
}

function codexUnexpectedStatus(status: number, messageOrBody: string): string {
  return `unexpected status ${status}: ${messageOrBody}, url: http://127.0.0.1/v1/responses`;
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

  it('accepts upstream provider image rejection (DeepSeek-style 400)', () => {
    const payload = JSON.stringify({
      error: {
        code: 'invalid_request_error',
        message: 'image_url content part is not supported by this model',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts upstream provider multimodal rejection', () => {
    const payload = JSON.stringify({
      error: {
        code: 'invalid_request',
        message: 'This model does not support multimodal input',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts handler-wrapped upstream image rejection (DeepSeek via bridge)', () => {
    // handler.ts wraps: responsesError(status, 'upstream_error', rawUpstreamBody)
    const innerError = JSON.stringify({
      error: { code: 'invalid_request_error', message: 'image_url content part is not supported' },
    });
    const payload = JSON.stringify({
      error: { code: 'upstream_error', message: innerError },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts upstream rejection using error.type without a code field', () => {
    const payload = JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'This model does not support image_url content parts',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts a plain-text (non-JSON) upstream 400 body wrapped by the handler', () => {
    const payload = JSON.stringify({
      error: {
        code: 'upstream_error',
        message: 'image_url content part is not supported by this model',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts a raw plain-text upstream capability rejection', () => {
    expect(
      isUnsupportedResponsesImageErrorPayload(
        'image_url content part is not supported by this model',
      ),
    ).toBe(true);
  });

  it('accepts a Codex-extracted plain-text capability rejection', () => {
    // Codex extracts error.message from the wrapped upstream_error envelope, so
    // the coordinator sees the plain-text message after the unexpected-status
    // prefix instead of the JSON envelope.
    expect(
      isUnsupportedResponsesImageErrorPayload(
        codexUnexpectedResponse('image_url content part is not supported by this model'),
      ),
    ).toBe(true);
  });

  it('rejects Codex-extracted invalid-image-content errors (not capability rejection)', () => {
    expect(
      isUnsupportedResponsesImageErrorPayload(
        codexUnexpectedResponse('Invalid image_url: image exceeds maximum size'),
      ),
    ).toBe(false);
  });

  it('accepts Codex-rendered 415/422 capability rejections (non-400 client errors)', () => {
    // Some OpenAI-compatible upstreams use 415 (unsupported_media_type) or
    // 422 (unprocessable_entity) to signal the model does not accept image
    // content parts. The plain-text classifier must not be gated on 400.
    expect(
      isUnsupportedResponsesImageErrorPayload(
        codexUnexpectedStatus(415, 'image_url content part is not supported by this model'),
      ),
    ).toBe(true);
    expect(
      isUnsupportedResponsesImageErrorPayload(
        codexUnexpectedStatus(422, 'image input is not supported by this model'),
      ),
    ).toBe(true);
  });

  it.each([401, 429, 500, 503])(
    'rejects Codex-rendered unrelated status %s even when the body mentions image capability',
    (status) => {
      expect(
        isUnsupportedResponsesImageErrorPayload(
          codexUnexpectedStatus(status, 'image_url content part is not supported by this model'),
        ),
      ).toBe(false);
    },
  );

  it('accepts Codex-rendered 422 with HTTP reason phrase', () => {
    // Codex includes the HTTP reason phrase, e.g.
    // 'unexpected status 422 Unprocessable Entity: ...'.
    expect(
      isUnsupportedResponsesImageErrorPayload(
        'unexpected status 422 Unprocessable Entity: image_url content part is not supported by this model, url: http://127.0.0.1/v1/responses',
      ),
    ).toBe(true);
    expect(
      isUnsupportedResponsesImageErrorPayload(
        'unexpected status 415 Unsupported Media Type: image input is not supported by this model, url: http://127.0.0.1/v1/responses',
      ),
    ).toBe(true);
  });

  it('accepts a JSON error whose error value is a plain string (Ollama-style)', () => {
    expect(
      isUnsupportedResponsesImageErrorPayload(
        JSON.stringify({ error: 'this model does not support images' }),
      ),
    ).toBe(true);

    const payload = JSON.stringify({
      error: { code: 'upstream_error', message: JSON.stringify({ error: 'this model does not support images' }) },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts a handler-wrapped rejection whose inner error uses error.type', () => {
    const innerError = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'image input is not supported' },
    });
    const payload = JSON.stringify({
      error: { code: 'upstream_error', message: innerError },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it.each([
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'Invalid image_url: image exceeds maximum size' },
    }),
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'image_url must be a valid URL' },
    }),
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'image exceeds maximum size' },
    }),
    JSON.stringify({
      error: { code: 'upstream_error', message: 'Invalid image_url: image exceeds maximum size' },
    }),
  ])('rejects invalid-image-content errors (not capability rejection): %s', (payload) => {
    // A message about the image being invalid (size, format, URL) is NOT a
    // capability rejection — stripping the attachment would resend text without
    // the image the user asked about.
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(false);
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
