import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCodexImageAuthBinding, setCodexImageAuthBinding } from '../codexImageAuthBinding.js';

afterEach(() => setCodexImageAuthBinding(null));

describe('codexImageAuthBinding', () => {
  it('fail closed before assembly and returns the statically injected callbacks', async () => {
    expect(() => getCodexImageAuthBinding()).toThrow('not configured');

    const getAuth = vi.fn(async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }));
    const onAuthFailure = vi.fn(async () => true);
    setCodexImageAuthBinding({ getAuth, onAuthFailure });

    await expect(getCodexImageAuthBinding().getAuth()).resolves.toEqual({
      accessToken: 'fake-token',
      accountId: 'fake-account',
    });
    expect(getAuth).toHaveBeenCalledOnce();
    await getCodexImageAuthBinding().onAuthFailure({
      status: 401,
      body: 'token_invalidated',
      failedAccessToken: 'fake-token',
    });
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it('bootstrap statically injects auth before Ghost IPC registration', () => {
    const bootstrap = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
      'utf-8',
    );
    const brain = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf-8',
    );

    expect(bootstrap).toContain("from './maker-host/anthropic-responses-bridge-host.js';");
    expect(bootstrap).toContain('getChatgptBridgeAuth,');
    expect(bootstrap).toContain('invalidateChatgptBridgeAuth,');
    expect(bootstrap.indexOf('setCodexImageAuthBinding({')).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('setCodexImageAuthBinding({')).toBeLessThan(
      bootstrap.indexOf('registerGhostIpc();'),
    );
    expect(brain).not.toMatch(
      /import\(\s*['"]\.\.\/maker-host\/anthropic-responses-bridge-host\.js['"]\s*\)/,
    );
  });
});
