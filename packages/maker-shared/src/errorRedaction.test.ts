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

  it('redacts gateway principals while keeping surrounding diagnostics', () => {
    const output = redactSensitiveText(
      '{"error":"ExceededBudget","principal":"aigw:v1:cindy:usr_a1b2c3","spend":12.34,"budget":10}',
    );

    expect(output).not.toContain('usr_a1b2c3');
    expect(output).toContain('aigw:[REDACTED]');
    expect(output).toContain('ExceededBudget');
    expect(output).toContain('"spend":12.34');

    const inline = redactSensitiveText('Request rejected (429): budget check failed for aigw:v1:cindy:usr_a1b2c3, retry later');
    expect(inline).not.toContain('usr_a1b2c3');
    expect(inline).toContain('aigw:[REDACTED], retry later');
  });

  it('keeps gateway principal redaction idempotent (review 反馈)', () => {
    // 没有 negative lookahead 时第二遍会匹配 `aigw:[REDACTED`(`]` 在排除集里),
    // 每跑一遍多长出一个 `]`;多路径重复调用 redactSensitiveText 是常态。
    const once = redactSensitiveText('aigw:v1:cindy:usr_a1b2c3');
    expect(once).toBe('aigw:[REDACTED]');
    expect(redactSensitiveText(once)).toBe('aigw:[REDACTED]');
    expect(redactSensitiveText(redactSensitiveText(once))).toBe('aigw:[REDACTED]');
    const inJson = redactSensitiveText(redactSensitiveText('{"principal":"aigw:v1:cindy:usr_a1b2c3"}'));
    expect(inJson).toContain('"aigw:[REDACTED]"');
  });

  it('recognizes gateway budget-exhaustion signals', () => {
    expect(
      extractNonSecretErrorSignals('Request rejected (429): ExceededBudget for aigw:v1:cindy:usr_a1b2c3'),
    ).toEqual({ errorStatus: 429, usageLimit: true });
    expect(extractNonSecretErrorSignals('{"code":"ExceededBudget"}')).toEqual({
      usageLimit: true,
    });
    // 网关结构化错误也常用 error / message 字段承载额度码(review 反馈:只认
    // code|type 会把 {"error":"ExceededBudget"} 判成普通错误进 blocked)。
    expect(extractNonSecretErrorSignals('{"error":"ExceededBudget","spend":12.3}')).toEqual({
      usageLimit: true,
    });
    expect(extractNonSecretErrorSignals('{"message":"budget_exceeded"}')).toEqual({
      usageLimit: true,
    });
    expect(extractNonSecretErrorSignals('upstream said budget_exceeded, status=429')).toEqual({
      errorStatus: 429,
      usageLimit: true,
    });
    // A 504 gateway timeout is not a quota signal and carries no supported status.
    expect(
      extractNonSecretErrorSignals('{"code":"origin_gateway_timeout","status":504}'),
    ).toEqual({ usageLimit: false });
  });

  it('keeps redaction idempotent for existing placeholders', () => {
    const output = 'access_token=[REDACTED] key=[REDACTED_KEY]';

    expect(redactSensitiveText(output)).toBe(output);
    expect(redactSensitiveText(redactSensitiveText('access_token=secret key=opaque-secret'))).toBe(
      'access_token=[REDACTED] key=[REDACTED]',
    );
  });
});
