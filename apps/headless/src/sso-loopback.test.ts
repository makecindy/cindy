import { describe, expect, it } from 'vitest';
import { waitForSsoCallback } from './sso-loopback.js';

describe('Linux SSO loopback callback', () => {
  it('accepts exactly the PKCE state-matched callback on a localhost-only listener', async () => {
    let ready: { redirectUri: string; authorizationUrl: string } | undefined;
    const result = waitForSsoCallback(
      (redirectUri) => `https://auth.example.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      'expected-state',
      (input) => { ready = input; },
    );
    await new Promise<void>((resolve) => {
      const wait = () => ready ? resolve() : setTimeout(wait, 1);
      wait();
    });
    expect(ready!.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(ready!.authorizationUrl).toContain(encodeURIComponent(ready!.redirectUri));

    const rejected = await fetch(`${ready!.redirectUri}?code=wrong&state=other`);
    expect(rejected.status).toBe(400);
    const accepted = await fetch(`${ready!.redirectUri}?code=good-code&state=expected-state`);
    expect(accepted.status).toBe(200);
    await expect(result).resolves.toEqual({ code: 'good-code' });
  });
});
