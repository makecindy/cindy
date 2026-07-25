import { describe, expect, it } from 'vitest';

import {
  extractNonSecretErrorSignals,
  redactSensitiveText,
} from './errorRedaction.js';

describe('redactSensitiveText', () => {
  it('redacts LiteLLM credential fields and bearer tokens while preserving context', () => {
    const input =
      'Invalid proxy server token passed; Received API Key = sk-live-123456789; Key Hash (Token) = hash-abc; Authorization: Bearer secret-token; status=401';
    const output = redactSensitiveText(input);

    expect(output).not.toContain('sk-live-123456789');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('hash-abc');
    expect(output).toContain('status=401');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts JSON and query-string token fields', () => {
    const output = redactSensitiveText(
      '{"api_key":"abc","access_token":"def","refresh_token":"ghi"} https://example.test?token=xyz',
    );

    expect(output).not.toMatch(/abc|def|ghi|token=xyz/);
    expect(output).toContain('"api_key":[REDACTED]');
    expect(output).toContain('token=[REDACTED]');
  });

  it('redacts URL userinfo credentials while keeping scheme and host', () => {
    const output = redactSensitiveText(
      'fetch failed for https://alice:s3cr3t@example.com/path?x=1',
    );

    expect(output).not.toContain('alice');
    expect(output).not.toContain('s3cr3t');
    expect(output).toContain('https://[REDACTED]@example.com/path');
  });

  it('redacts username-only URL userinfo (bare token) and leaves path @ untouched', () => {
    const output = redactSensitiveText(
      'clone https://ghp_tokenValue123@github.com/org/repo and see user@host/inbox@2 path',
    );

    expect(output).not.toContain('ghp_tokenValue123');
    expect(output).toContain('https://[REDACTED]@github.com/org/repo');
    // `@` inside a path (no scheme:// userinfo) must be preserved.
    expect(output).toContain('user@host/inbox@2');
  });

  it('redacts complete non-Bearer Authorization values', () => {
    const output = redactSensitiveText('Authorization: Basic dXNlcjpwYXNz');

    expect(output).toBe('Authorization: [REDACTED]');
    expect(output).not.toContain('dXNlcjpwYXNz');
  });

  it('redacts Cookie and Set-Cookie header values', () => {
    const output = redactSensitiveText(
      'Cookie: session=abc123; refresh=def456\nSet-Cookie: sid=ghi789; HttpOnly',
    );

    expect(output).toBe('Cookie: [REDACTED]\nSet-Cookie: [REDACTED]');
    expect(output).not.toMatch(/abc123|def456|ghi789/);
  });

  it('redacts Proxy-Authorization header values', () => {
    const output = redactSensitiveText('Proxy-Authorization: Basic dXNlcjpwYXNz');

    expect(output).toBe('Proxy-Authorization: [REDACTED]');
    expect(output).not.toContain('dXNlcjpwYXNz');
  });

  it('preserves only explicit status and quota signals', () => {
    expect(extractNonSecretErrorSignals('Authorization: Bearer tok-401-x; upstream 500')).toEqual({
      usageLimit: false,
    });
    expect(
      extractNonSecretErrorSignals('Authorization: Bearer secret-token, quota exhausted, status=429'),
    ).toEqual({ errorStatus: 429, usageLimit: true });
    expect(
      extractNonSecretErrorSignals(
        'Authorization: Bearer secret-token, "status":"401", "http_status":"429"',
      ),
    ).toEqual({ errorStatus: 401, usageLimit: false });
    expect(
      extractNonSecretErrorSignals('Authorization: Bearer secret-token, HTTP 401 Unauthorized'),
    ).toEqual({ errorStatus: 401, usageLimit: false });
    expect(
      extractNonSecretErrorSignals('Authorization: Bearer secret-token, HTTP 401: Unauthorized'),
    ).toEqual({ errorStatus: 401, usageLimit: false });
    expect(
      extractNonSecretErrorSignals('Authorization: Bearer secret-token, code 429'),
    ).toEqual({ errorStatus: 429, usageLimit: false });
    expect(
      extractNonSecretErrorSignals(
        'Authorization: Bearer secret-token, code=rate_limit_exceeded',
      ),
    ).toEqual({ usageLimit: true });
    expect(extractNonSecretErrorSignals('{"type":"insufficient_quota"}')).toEqual({
      usageLimit: true,
    });
  });

  it('redacts comma-delimited Authorization parameters without leaking signatures', () => {
    const output = redactSensitiveText(
      'Authorization: AWS4-HMAC-SHA256 Credential=abc, SignedHeaders=host, Signature=secret; status=401',
    );

    expect(output).toBe('Authorization: [REDACTED]; status=401');
    expect(output).not.toMatch(/Credential=abc|Signature=secret/);
  });

  it('redacts opaque custom-provider key fields', () => {
    const output = redactSensitiveText('provider failed: key=abcd1234secret');

    expect(output).toBe('provider failed: key=[REDACTED]');
    expect(output).not.toContain('abcd1234secret');
  });

  it('redacts OAuth client secret fields', () => {
    const output = redactSensitiveText('oauth client_secret=abc123 clientSecret: def456 secret=ghi789');

    expect(output).toBe('oauth client_secret=[REDACTED] clientSecret: [REDACTED] secret=[REDACTED]');
    expect(output).not.toMatch(/abc123|def456|ghi789/);
  });

  it('redacts password fields', () => {
    const output = redactSensitiveText('proxy password=abc123 password: def456 passwd=ghi789');

    expect(output).toBe('proxy password=[REDACTED] password: [REDACTED] passwd=[REDACTED]');
    expect(output).not.toMatch(/abc123|def456|ghi789/);
  });

  it('keeps redaction idempotent for existing placeholders', () => {
    const output = 'access_token=[REDACTED] key=[REDACTED_KEY]';

    expect(redactSensitiveText(output)).toBe(output);
    expect(redactSensitiveText(redactSensitiveText('access_token=secret key=opaque-secret'))).toBe(
      'access_token=[REDACTED] key=[REDACTED]',
    );
  });
});
