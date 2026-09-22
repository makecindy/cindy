import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetchRaw, registerAccountUnavailableHandler, type ApiFetchOptions } from '@/api/client';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { SharedTaskScopeChangedError } from '@cindy/device-link';
import { useSharedTaskApi } from '@/device-link/useSharedTaskApi';

type ApiFetch = <T>(path: string, opts: Omit<ApiFetchOptions, 'token'>) => Promise<T>;
const auth = vi.hoisted(() => ({ apiFetch: null as unknown as ApiFetch, accountGeneration: 1 }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react', () => ({ useMemo: (factory: () => unknown) => factory() }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid' }));

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
  auth.apiFetch = new Function('getAccessToken', 'refresh', 'terminateSession', 'userRef', 'ApiError', 'apiFetchRaw', compiled + '; return request;')(getAccessToken, refresh, terminateSession, { current: { id: 'account-a' } }, ApiError, apiFetchRaw);
});
afterEach(() => { vi.unstubAllGlobals(); setMobileAuthOwner(null); });

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
});
