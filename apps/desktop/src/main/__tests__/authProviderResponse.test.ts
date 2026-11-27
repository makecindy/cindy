import { describe, expect, it, vi } from 'vitest';
import { CindyAuthClient } from '@cindy/auth-client';
import { withProviderResponseDiagnostics } from '../authProviderResponse';
import { mapLoginProvidersLoadFailure } from '../authStartupGate';
import { loginPreparingErrorState } from '../../shared/authIpc';

// #10617: real client + host adapter, unit tier. Existing JSON failures did not
// exercise a proxy HTML response, its safe log or HTTP presentation metadata.
function setup(body: string, status = 418, headers: Record<string, string> = {}) {
  const report = vi.fn();
  const fetch = vi.fn(async () => new Response(body, { status, headers }));
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.example.com', region: 'global', deviceId: 'test', clientType: 'desktop',
    fetch: withProviderResponseDiagnostics(fetch, report),
  });
  return { client, report, fetch };
}

describe('public providers response diagnostics', () => {
  it('preserves 418 and logs the responder and safe body without another request', async () => {
    const { client, report, fetch } = setup('<html><title>418</title>Request blocked by proxy</html>', 418,
      { server: 'edge-proxy', via: '1.1 gateway', 'set-cookie': 'private-cookie' });
    const failure = await client.getProviders().catch(mapLoginProvidersLoadFailure);
    expect(failure).toMatchObject({ success: false, code: 'INVALID_RESPONSE', state: { httpStatus: 418 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({ status: 418, server: 'edge-proxy', via: '1.1 gateway',
      bodyPrefix: '<html><title>418</title>Request blocked by proxy</html>' });
    expect(loginPreparingErrorState('INVALID_RESPONSE', undefined, 418)).toMatchObject({ httpStatus: 418 });
  });

  it('redacts echoed credentials and HTML attributes before limiting the logged prefix', async () => {
    const secrets = ['private-cookie', 'private-bearer', 'private-password', 'hidden-value', 'script-value'];
    const body = `<html><input value="${secrets[3]}"><script>${secrets[4]}</script>\n` +
      `http://user:proxy-password@proxy.invalid/ Basic short-secret\nCookie: ${secrets[0]}\nAuthorization: Bearer ${secrets[1]}\npassword=${secrets[2]}\n` + 'Blocked '.repeat(200);
    const { client, report } = setup(body, 418, { server: 'nginx', via: 'Authorization: Bearer via-secret' });
    await expect(client.getProviders()).rejects.toMatchObject({ statusCode: 418 });
    const logged = JSON.stringify(report.mock.calls);
    for (const secret of [...secrets, 'via-secret', 'proxy-password', 'short-secret']) expect(logged).not.toContain(secret);
    expect(report.mock.calls[0][0].bodyPrefix.length).toBeLessThanOrEqual(512);
    expect(report.mock.calls[0][0].bodyPrefix).not.toMatch(/[\r\n]/);
  });

  // Review #10627: output truncation did not bound synchronous redaction work.
  // One character above the diagnostic budget must omit the whole unsafe value.
  it('omits oversized diagnostics while preserving the responder and HTTP failure', async () => {
    const body = '<html>password=private-secret'.padEnd(16 * 1024 + 1, 'x');
    const { client, report, fetch } = setup(body, 418, { server: 'edge-proxy', via: '1.1 gateway' });
    const failure = await client.getProviders().catch(mapLoginProvidersLoadFailure);
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE', state: { httpStatus: 418 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({ status: 418, server: 'edge-proxy', via: '1.1 gateway',
      bodyPrefix: '[omitted: exceeds diagnostic limit]' });
  });

  it('keeps structured server errors and authenticated endpoints out of body diagnostics', async () => {
    const structured = setup(JSON.stringify({ error: { code: 'AUTH_REQUEST_FAILED' }, detail: 'x'.repeat(16 * 1024 + 1) }), 503);
    await expect(structured.client.getProviders()).rejects.toMatchObject({ code: 'AUTH_REQUEST_FAILED', statusCode: 503 });
    expect(structured.report).not.toHaveBeenCalled();
    const authenticated = setup('<html>private account response</html>');
    await expect(authenticated.client.refresh('test-token')).rejects.toMatchObject({ statusCode: 418 });
    expect(authenticated.report).not.toHaveBeenCalled();
  });

  it('retains rate-limit semantics and tolerates a failing diagnostic sink', async () => {
    const limited = setup('<html>too many requests</html>', 429, { 'retry-after': '60' });
    await expect(limited.client.getProviders()).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429, retryAt: expect.any(Number) });
    const failure = setup('<html>blocked</html>');
    failure.report.mockImplementation(() => { throw new Error('logger failed'); });
    await expect(failure.client.getProviders()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', statusCode: 418 });
    expect(loginPreparingErrorState('INVALID_RESPONSE', undefined, 200)).not.toHaveProperty('httpStatus');
  });
});
