import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  authUrl: '',
  exchangeStarted: 0,
  resolveExchange: null as
    ((response: { status: number; json: () => Promise<unknown> }) => void) | null,
  loginWrites: 0,
  authorizationStages: 0,
  revocationStages: 0,
  unbinds: 0,
  warnings: [] as unknown[],
  requestHandler: null as ((request: unknown, response: unknown) => void) | null,
  responseEnded: 0,
  bindingState: 'bound' as 'bound' | 'unbound' | 'unreadable',
}));

vi.mock('node:http', () => ({
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    address: () => ({ port: 43123 }),
    on: (event: string, handler: (request: unknown, response: unknown) => void) => {
      if (event === 'request') h.requestHandler = handler;
    },
    removeAllListeners: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn(async (url: string) => {
      h.authUrl = url;
    }),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner-a', generation: 7 }),
  isAppSessionBoundaryPending: () => false,
}));

vi.mock('../claude-credentials-store.js', () => ({
  writeClaudeAiOAuthWithBindingCommit: (_oauth: unknown, commit: () => boolean) => {
    h.loginWrites += 1;
    return commit();
  },
  clearClaudeAiOAuthWithBindingCommit: (validate: () => boolean, commit: () => boolean) =>
    validate() && commit() ? 'cleared' : 'binding-changed',
  readClaudeAiOAuth: () => null,
  replaceClaudeAiOAuthIfMatches: () => 'written',
}));

vi.mock('../nativeProviderAuthBinding.js', () => ({
  captureNativeProviderAuthOwnerFence: () => ({ dataOwnerId: 'owner-a', generation: 7 }),
  beginNativeProviderAuthAuthorization: () => ({
    dataOwnerId: 'owner-a',
    generation: 7,
    operationId: 'login-operation',
    intent: 'authorize',
  }),
  beginNativeProviderAuthDisconnect: () => ({
    dataOwnerId: 'owner-a',
    generation: 7,
    operationId: 'logout-operation',
    intent: 'revoke',
  }),
  abandonNativeProviderAuthOperation: () => true,
  isNativeProviderAuthOwnerFenceCurrent: () => true,
  stageNativeProviderAuthAuthorization: () => {
    h.authorizationStages += 1;
    return true;
  },
  bindNativeProviderAuth: () => true,
  getNativeProviderAuthBindingState: () => h.bindingState,
  getNativeProviderAuthBindingStateForOperation: () => h.bindingState,
  validateNativeProviderAuthRevocationPending: () => true,
  markNativeProviderAuthRevocationPending: () => {
    h.revocationStages += 1;
    return true;
  },
  unbindNativeProviderAuth: () => {
    h.unbinds += 1;
    return true;
  },
}));

vi.mock('../outbound-fetch.js', () => ({
  outboundFetch: vi.fn(
    () =>
      new Promise((resolve) => {
        h.exchangeStarted += 1;
        h.resolveExchange = resolve;
      }),
  ),
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn((...args: unknown[]) => h.warnings.push(args)),
      error: vi.fn(),
    }),
  },
}));

import { runClaudeOAuthLogin } from '../claude-oauth-login.js';
import { disconnectClaudeAiOAuth } from '../claude-oauth-refresh.js';

describe('Claude OAuth login/logout last-intent race', () => {
  beforeEach(() => {
    h.authUrl = '';
    h.exchangeStarted = 0;
    h.resolveExchange = null;
    h.loginWrites = 0;
    h.authorizationStages = 0;
    h.revocationStages = 0;
    h.unbinds = 0;
    h.warnings.length = 0;
    h.requestHandler = null;
    h.responseEnded = 0;
    h.bindingState = 'bound';
  });

  it('logout cancels a deferred token exchange and the late login cannot restore credentials', async () => {
    const login = runClaudeOAuthLogin();
    await vi.waitFor(() => expect(h.authUrl, JSON.stringify(h.warnings)).not.toBe(''));

    const authUrl = new URL(h.authUrl);
    h.requestHandler?.(
      {
        url: `/callback?code=late-code&state=${encodeURIComponent(
          authUrl.searchParams.get('state') ?? '',
        )}`,
        headers: { host: 'localhost', 'accept-language': 'en' },
      },
      {
        writeHead: vi.fn(),
        end: () => {
          h.responseEnded += 1;
        },
      },
    );
    await vi.waitFor(() => expect(h.exchangeStarted).toBe(1));

    expect(() => disconnectClaudeAiOAuth()).not.toThrow();
    h.resolveExchange?.({
      status: 200,
      json: async () => ({
        access_token: 'late-access-token',
        refresh_token: 'late-refresh-token',
        expires_in: 3600,
        scope: 'user:inference',
      }),
    });

    await expect(login).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    expect(h.responseEnded).toBe(1);
    expect(h.loginWrites).toBe(0);
    expect(h.authorizationStages).toBe(0);
    expect(h.revocationStages).toBe(1);
    expect(h.unbinds).toBe(1);
  });

  it('initial-login logout still cancels the exchange when the main binding is absent', async () => {
    h.bindingState = 'unbound';
    const login = runClaudeOAuthLogin();
    await vi.waitFor(() => expect(h.authUrl, JSON.stringify(h.warnings)).not.toBe(''));

    const authUrl = new URL(h.authUrl);
    h.requestHandler?.(
      {
        url: `/callback?code=late-code&state=${encodeURIComponent(
          authUrl.searchParams.get('state') ?? '',
        )}`,
        headers: { host: 'localhost', 'accept-language': 'en' },
      },
      {
        writeHead: vi.fn(),
        end: () => {
          h.responseEnded += 1;
        },
      },
    );
    await vi.waitFor(() => expect(h.exchangeStarted).toBe(1));

    expect(disconnectClaudeAiOAuth()).toBe('confirmed-unbound');
    h.resolveExchange?.({
      status: 200,
      json: async () => ({
        access_token: 'late-access-token',
        refresh_token: 'late-refresh-token',
        expires_in: 3600,
        scope: 'user:inference',
      }),
    });

    await expect(login).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    expect(h.loginWrites).toBe(0);
    expect(h.authorizationStages).toBe(0);
    expect(h.revocationStages).toBe(0);
    expect(h.unbinds).toBe(0);
  });
});
