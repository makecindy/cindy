import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import { buildCodexEnv } from './env-builder.js';

function createAuthAdapter(env: Record<string, string> = {}): AuthAdapter {
  return {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return env;
    },
  };
}

describe('buildCodexEnv', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalCliColor = process.env.CLICOLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  const originalTerm = process.env.TERM;
  const originalPsOutputRendering = process.env.PSStyle__OutputRendering;

  afterEach(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NO_COLOR', originalNoColor);
    restore('CLICOLOR', originalCliColor);
    restore('FORCE_COLOR', originalForceColor);
    restore('TERM', originalTerm);
    restore('PSStyle__OutputRendering', originalPsOutputRendering);
  });

  it('defaults command output to plain text across common CLI color controls', async () => {
    delete process.env.NO_COLOR;
    delete process.env.CLICOLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
    delete process.env.PSStyle__OutputRendering;

    const env = await buildCodexEnv(createAuthAdapter(), {});

    expect(env.NO_COLOR).toBe('1');
    expect(env.CLICOLOR).toBe('0');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.TERM).toBe('dumb');
    expect(env.PSStyle__OutputRendering).toBe('PlainText');
  });

  it('passes requested credential mode to the auth adapter', async () => {
    const getAuthEnv = vi.fn(async () => ({ CODEX_HOME: '/tmp/codex-home' }));
    const env = await buildCodexEnv(
      {
        ...createAuthAdapter(),
        getAuthEnv,
      },
      {},
      { credentialMode: 'gateway-key' },
    );

    expect(getAuthEnv).toHaveBeenCalledWith({ credentialMode: 'gateway-key' });
    expect(env.CODEX_HOME).toBe('/tmp/codex-home');
  });

  it('passes a selected native account even without a separate credentialMode flag', async () => {
    const nativeSubscriptionAccount = { id: 'fixture', configDir: '/fixture/.codex-second', assertCurrent() {}, readState: async () => ({ authenticated: true }) };
    const getAuthEnv = vi.fn(async () => ({ CODEX_HOME: nativeSubscriptionAccount.configDir }));
    const env = await buildCodexEnv({ ...createAuthAdapter(), getAuthEnv }, {}, { nativeSubscriptionAccount });
    expect(getAuthEnv).toHaveBeenCalledExactlyOnceWith({ nativeSubscriptionAccount });
    expect(env.CODEX_HOME).toBe(nativeSubscriptionAccount.configDir);
  });

  it('keeps explicit command color environment overrides', async () => {
    process.env.NO_COLOR = '0';
    process.env.CLICOLOR = '1';
    process.env.FORCE_COLOR = '1';
    process.env.TERM = 'xterm-256color';
    process.env.PSStyle__OutputRendering = 'Ansi';

    const env = await buildCodexEnv(createAuthAdapter(), {});

    expect(env.NO_COLOR).toBe('0');
    expect(env.CLICOLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.PSStyle__OutputRendering).toBe('Ansi');
  });
});
