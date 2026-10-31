import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetchRaw, registerAccountUnavailableHandler, type ApiFetchOptions } from '@/api/client';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { SharedTaskScopeChangedError } from '@cindy/device-link';
import { useSharedTaskApi } from '@/device-link/useSharedTaskApi';
import {
  __testing as relayRoutingTesting,
  deviceLinkMediaApiBaseUrl,
  isSelfHostedRelayBaseUrl,
  setActiveSelfHostedRelay,
} from '@/device-link/selfHostedRelayRouting';

type ApiFetch = <T>(path: string, opts: Omit<ApiFetchOptions, 'token'>) => Promise<T>;
const auth = vi.hoisted(() => ({ apiFetch: null as unknown as ApiFetch, accountGeneration: 1 }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react', () => ({ useMemo: (factory: () => unknown) => factory() }));
vi.mock('@/config/env', () => ({
  DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid',
  getOfficialDeviceLinkApiBaseUrl: () => 'https://official.example.invalid',
  setDeviceLinkApiBaseOverride: () => {},
}));

// Execute the provider callback with in-memory auth dependencies, without native
// login/storage. The shared-task hook and HTTP transport remain real.
const source = ts.createSourceFile('AuthContext.tsx', readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
let refreshable: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'apiFetch' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'isRefreshableUnauthorizedCode') refreshable = node;
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback || !refreshable) throw new Error('AuthProvider API callback not found');
const compiled = ts.transpileModule(refreshable.getText(source) + '; const request = ' + callback.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const getAccessToken = vi.fn<() => Promise<string | null>>();
const refresh = vi.fn<() => Promise<string | null>>();
const terminateSession = vi.fn();
const fetchMock = vi.fn();
const closed = { sharedTaskId: 'shared-a', status: 'closed' };
const response = (status = 200, code = 'TOKEN_EXPIRED') => ({ ok: status === 200, status, json: async () => status === 200 ? closed : { code } }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  setMobileAuthOwner('account-a');
  getAccessToken.mockResolvedValue('fake-token-a');
  refresh.mockResolvedValue('fake-refreshed-a');
  fetchMock.mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
  auth.apiFetch = new Function('getAccessToken', 'refresh', 'terminateSession', 'userRef', 'ApiError', 'apiFetchRaw', 'isSelfHostedRelayBaseUrl', compiled + '; return request;')(getAccessToken, refresh, terminateSession, { current: { id: 'account-a' } }, ApiError, apiFetchRaw, isSelfHostedRelayBaseUrl);
});
afterEach(() => { vi.unstubAllGlobals(); setMobileAuthOwner(null); relayRoutingTesting.reset(); });

describe('shared-task HTTP account fence', () => {
  it('sends and refreshes once while the originating account remains current', async () => {
    fetchMock.mockResolvedValueOnce(response(401));
    await expect(useSharedTaskApi().close('shared-a')).resolves.toEqual(closed);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fake-refreshed-a');
  });
  it('does not send after switching accounts while obtaining the token', async () => {
    const token = deferred<string>();
    getAccessToken.mockReturnValue(token.promise);
    const request = useSharedTaskApi().close('shared-a');
    setMobileAuthOwner('account-b');
    token.resolve('fake-token-b');
    await expect(request).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['TOKEN_EXPIRED', 'ACCOUNT_UNAVAILABLE'])('ignores a late %s without refreshing or logging out the new account', async (code) => {
    const pending = deferred<Response>();
    const terminal = vi.fn();
    const dispose = registerAccountUnavailableHandler(terminal);
    fetchMock.mockReturnValue(pending.promise);
    try {
      const request = useSharedTaskApi().close('shared-a');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      setMobileAuthOwner('account-b');
      pending.resolve(response(401, code));
      await expect(request).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
      expect(refresh).not.toHaveBeenCalled();
      expect(terminateSession).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
    } finally { dispose(); }
  });
  it.each(['account', 'realm', 'logout', 'away-and-back'])('does not retry after %s changes during refresh', async (change) => {
    const fresh = deferred<string | null>();
    refresh.mockReturnValue(fresh.promise);
    fetchMock.mockResolvedValueOnce(response(401));
    const request = useSharedTaskApi().close('shared-a');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    if (change === 'realm') setMobileAuthOwner('account-a', 'cn');
    else if (change === 'logout') setMobileAuthOwner(null);
    else { setMobileAuthOwner('account-b'); if (change === 'away-and-back') setMobileAuthOwner('account-a'); }
    fresh.resolve(change === 'logout' ? null : 'fake-token-new-owner');
    await expect(request).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(terminateSession).not.toHaveBeenCalled();
  });
  it('keeps ordinary API callers without a scope guard compatible', async () => {
    fetchMock.mockResolvedValueOnce(response(401));
    await expect(auth.apiFetch('/resource', { baseUrl: 'https://relay.example.invalid' })).resolves.toEqual(closed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  // Shared-task membership lives on the official service (docs/self-hosted-relay-plan.md §7): the
  // API and its attachments stay there with the account token while a self-hosted relay is active.
  it('keeps shared-task requests and attachments on the official service while a self-hosted relay is active', async () => {
    setActiveSelfHostedRelay({ relayId: 'relay-1', name: 'Home', baseUrl: 'https://relay.home.example', credential: 'relay-credential', signing: null });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ sharedTasks: [] }) } as unknown as Response);
    await expect(useSharedTaskApi().list()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://official.example.invalid/api/device-link/shared-tasks');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /);
    expect(deviceLinkMediaApiBaseUrl('cindy/device-link/shared-task/task-a/member/file.png')).toBe('https://official.example.invalid');
    expect(deviceLinkMediaApiBaseUrl('cindy/device-link/account/file.png')).toBe('https://relay.example.invalid');
  });

  // Self-hosted relay (docs/self-hosted-relay-plan.md §5.3): even a proxy-style 401 (HTTP_401, normally
  // refreshable) from the relay must not fetch, refresh or send the account token, nor end the session.
  it('sends self-hosted relay requests with the relay credential only, without refresh or sign-out on 401', async () => {
    setActiveSelfHostedRelay({ relayId: 'relay-1', name: 'Home', baseUrl: 'https://relay.home.example', credential: 'relay-credential', signing: null });
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => null } as unknown as Response);
    await expect(auth.apiFetch('/api/device-link/devices', { baseUrl: 'https://relay.home.example' }))
      .rejects.toMatchObject({ code: 'RELAY_CREDENTIAL_INVALID', status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('CindyRelay relay-credential');
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(terminateSession).not.toHaveBeenCalled();
  });
});
