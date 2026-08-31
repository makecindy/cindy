import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_USER_DISCONNECT_REASON,
  getCodexAuthInvalidationMarkerPath,
  getActiveInvalidatedSystemCodexAuthMarker,
  readInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  settleInvalidationMarkerAfterLogin,
  shouldSuppressLocalCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
} from '../codex-auth-invalidation.js';

const dirs: string[] = [];
const h = vi.hoisted(() => ({
  userDataDir: '',
  dataOwnerId: null as string | null,
  sessionGeneration: 1,
  sessionBoundaryPending: false,
  isPackaged: true,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userDataDir,
    getAppPath: () => h.userDataDir,
    get isPackaged() {
      return h.isPackaged;
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return {
    ...actual,
    getActiveAppSession: () => ({
      mode: h.dataOwnerId ? ('cloud' as const) : ('signed-out' as const),
      dataOwnerId: h.dataOwnerId,
      generation: h.sessionGeneration,
    }),
    activeOwnerScopeKey: () =>
      `${h.dataOwnerId ? 'cloud' : 'signed-out'}:${h.dataOwnerId ?? 'none'}:${h.sessionGeneration}`,
    isAppSessionBoundaryPending: () => h.sessionBoundaryPending,
  };
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-auth-marker-'));
  dirs.push(root);
  const codexHome = path.join(root, 'app-codex-home');
  const systemAuth = path.join(root, 'system-codex', 'auth.json');
  const localAuth = path.join(codexHome, 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'system-token' } }));
  return { codexHome, systemAuth, localAuth };
}

function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('compares Codex hard-link identities without Windows number precision collisions', async () => {
  const { haveSameStableFileIdentity } = await import('../auth-adapters.js');
  expect(
    haveSameStableFileIdentity(
      { dev: 0n, ino: 9_007_199_254_740_992n },
      { dev: 0n, ino: 9_007_199_254_740_993n },
    ),
  ).toBe(false);
  expect(haveSameStableFileIdentity({ dev: 0n, ino: 0n }, { dev: 0n, ino: 0n })).toBe(false);
  expect(haveSameStableFileIdentity({ dev: 7n, ino: 11n }, { dev: 7n, ino: 11n })).toBe(true);
});

it('does not chmod a system-shared auth file while finalizing login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-shared-mode-'));
  dirs.push(root);
  h.userDataDir = path.join(root, 'user-data');
  h.dataOwnerId = 'owner-a';
  const home = path.join(root, 'home');
  const systemAuth = path.join(home, '.codex', 'auth.json');
  const codexHome = path.join(h.userDataDir, 'codex-home');
  const localAuth = path.join(codexHome, 'auth.json');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    systemAuth,
    JSON.stringify({ tokens: { access_token: 'shared-token', account_id: 'acct-1' } }),
  );
  fs.linkSync(systemAuth, localAuth);
  const chmod = vi.spyOn(fs.promises, 'chmod');
  const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
  const adapter = new DesktopCodexAuthAdapter();
  const finishSuccessfulCodexLogin = (
    adapter as unknown as {
      finishSuccessfulCodexLogin(): Promise<{ authenticated: boolean }>;
    }
  ).finishSuccessfulCodexLogin.bind(adapter);

  await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({ authenticated: true });
  expect(chmod).not.toHaveBeenCalled();
  expect(fs.statSync(systemAuth).ino).toBe(fs.statSync(localAuth).ino);
});

async function createRecoveryCandidate(
  credentialScope: 'system-shared' | 'instance-isolated' | 'unknown',
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-recovery-proof-'));
  dirs.push(root);
  h.userDataDir = path.join(root, 'user-data');
  h.dataOwnerId = 'owner-a';
  const home = path.join(root, 'home');
  const systemAuth = path.join(home, '.codex', 'auth.json');
  const codexHome = path.join(h.userDataDir, 'codex-home');
  const localAuth = path.join(codexHome, 'auth.json');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    systemAuth,
    JSON.stringify({ tokens: { access_token: 'expired-system-token', account_id: 'acct-1' } }),
  );
  fs.writeFileSync(
    localAuth,
    JSON.stringify({ tokens: { access_token: 'expired-local-token', account_id: 'acct-1' } }),
  );
  if (
    !writeInvalidatedSystemCodexAuthMarker(
      codexHome,
      systemAuth,
      'token_revoked',
      localAuth,
      credentialScope,
      credentialScope === 'system-shared' ? 'owner-a' : undefined,
    )
  ) {
    throw new Error('failed to create Codex recovery marker fixture');
  }
  fs.writeFileSync(
    localAuth,
    JSON.stringify({ tokens: { access_token: 'replacement-token', account_id: 'acct-1' } }),
  );
  const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
  return {
    adapter: new DesktopCodexAuthAdapter(),
    codexHome,
    localAuth,
    markerPath: getCodexAuthInvalidationMarkerPath(codexHome),
    systemAuth,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  h.dataOwnerId = null;
  h.sessionGeneration = 1;
  h.sessionBoundaryPending = false;
  h.isPackaged = true;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex system credential suppression marker', () => {
  it('qualifies the Windows ACL principal when the machine and user names can collide', async () => {
    const { resolveWindowsAclPrincipal } = await import('../auth-adapters.js');

    expect(
      resolveWindowsAclPrincipal({ USERDOMAIN: 'WORKSTATION', USERNAME: 'alex' }, 'fallback'),
    ).toBe('WORKSTATION\\alex');
    expect(
      resolveWindowsAclPrincipal({ USERDOMAIN: 'WORKSTATION', USERNAME: 'DOMAIN\\alex' }, 'fallback'),
    ).toBe('DOMAIN\\alex');
    expect(resolveWindowsAclPrincipal({}, 'fallback')).toBe('fallback');
  });

  it('user disconnect persists as reconcile suppression without surfacing an auth error', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    writeInvalidatedSystemCodexAuthMarker(
      codexHome,
      systemAuth,
      CODEX_USER_DISCONNECT_REASON,
      localAuth,
    );

    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: null,
    });
  });

  it('system credential changes do not expire an explicit XDMaker disconnect', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    writeInvalidatedSystemCodexAuthMarker(
      codexHome,
      systemAuth,
      CODEX_USER_DISCONNECT_REASON,
      localAuth,
    );
    fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'new-system-token' } }));

    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)?.reason).toBe(
      CODEX_USER_DISCONNECT_REASON,
    );
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: null,
    });
  });

  it('persists a disconnect sentinel even when the system credential is currently absent', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.rmSync(systemAuth);

    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        CODEX_USER_DISCONNECT_REASON,
        localAuth,
      ),
    ).toBe(true);
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)?.reason).toBe(
      CODEX_USER_DISCONNECT_REASON,
    );
  });

  it('keeps the durable disconnect when a later local OAuth token is invalidated', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        CODEX_USER_DISCONNECT_REASON,
        localAuth,
      ),
    ).toBe(true);

    // 用户在 XDMaker 内显式重登得到隔离 token，之后该 token 又被服务端判失效。
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'local-token' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(codexHome, systemAuth, 'token_invalidated', localAuth),
    ).toBe(true);
    fs.rmSync(localAuth);
    fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'new-system-token' } }));

    const marker = getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth);
    expect(marker).toMatchObject({ reason: 'token_invalidated', durableDisconnect: true });
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: 'token_invalidated',
    });
  });

  it('cleans a matching local credential left by a crash after the disconnect marker committed', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'old-local-token' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        CODEX_USER_DISCONNECT_REASON,
        localAuth,
      ),
    ).toBe(true);
    expect(shouldSuppressLocalCodexAuth(codexHome, localAuth)).toBe(true);

    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: null,
    });
    expect(fs.existsSync(localAuth)).toBe(false);
  });

  it('suppresses a matching local credential after server-side token invalidation', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'invalid-token' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(codexHome, systemAuth, 'token_invalidated', localAuth),
    ).toBe(true);

    expect(shouldSuppressLocalCodexAuth(codexHome, localAuth)).toBe(true);
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'new-token' } }));
    expect(shouldSuppressLocalCodexAuth(codexHome, localAuth)).toBe(false);
  });

  it('persists an isolated invalidation without system auth and ignores unrelated system changes', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'invalid-local' } }));
    fs.rmSync(systemAuth);

    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });

    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'unrelated-system' } }));
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('persists an unknown-source invalidation without system auth until Cindy writes a new token', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'legacy-local' } }));
    fs.rmSync(systemAuth);

    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'unknown',
      ),
    ).toBe(true);
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: 'token_revoked',
      credentialScope: 'unknown',
    });

    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'new-cindy-token' } }));
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: null,
      recoveryRequiredReason: 'token_revoked',
      credentialScope: 'unknown',
    });
    expect(shouldSuppressLocalCodexAuth(codexHome, localAuth)).toBe(false);
  });

  it('keeps system reconcile suppressed after a new isolated local credential replaces it', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'invalid-local' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);

    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'new-local' } }));
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: null,
      recoveryRequiredReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    expect(shouldSuppressLocalCodexAuth(codexHome, localAuth)).toBe(false);
  });

  it('keeps an isolated suppression marker in the successful-login finalizer', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'invalid-local' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);

    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'new-local' } }));
    expect(settleInvalidationMarkerAfterLogin(codexHome, systemAuth)).toEqual({
      keepSuppressed: true,
    });
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    expect(shouldSuppressLocalCodexAuth(codexHome, localAuth)).toBe(false);
  });

  it('preserves a durable disconnect while a replacement isolated token clears the error', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'old-local' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        CODEX_USER_DISCONNECT_REASON,
        localAuth,
      ),
    ).toBe(true);
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);

    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'new-local' } }));
    expect(settleInvalidationMarkerAfterLogin(codexHome, systemAuth)).toEqual({
      keepSuppressed: true,
    });
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
      durableDisconnect: true,
    });
    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: null,
      credentialScope: 'instance-isolated',
    });
  });

  it('does not relink a successful isolated login to a same-account system credential', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-isolated-finalize-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'system-token', account_id: 'acct-1' },
      }),
    );
    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'expired-local', account_id: 'acct-1' },
      }),
    );
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'token_revoked',
    });
    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'new-local-token', account_id: 'acct-1' },
      }),
    );

    const finishSuccessfulCodexLogin = (
      adapter as unknown as {
        finishSuccessfulCodexLogin(): Promise<{ authenticated: boolean }>;
      }
    ).finishSuccessfulCodexLogin.bind(adapter);
    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({ authenticated: true });
    expect(fs.readFileSync(localAuth, 'utf8')).not.toBe(fs.readFileSync(systemAuth, 'utf8'));
    expect(JSON.parse(fs.readFileSync(localAuth, 'utf8'))).toMatchObject({
      tokens: { access_token: 'new-local-token', account_id: 'acct-1' },
    });
  });

  it('reclassifies a shared invalidation as isolated after an explicit Cindy login', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-shared-to-isolated-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'expired-system-token', account_id: 'acct-1' },
      }),
    );
    fs.linkSync(systemAuth, localAuth);
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-a' }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
    });
    await expect(adapter.invalidate('token_revoked')).resolves.toBeUndefined();
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });

    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'new-cindy-token', account_id: 'acct-1' },
      }),
    );
    const finishSuccessfulCodexLogin = (
      adapter as unknown as {
        finishSuccessfulCodexLogin(): Promise<{
          authenticated: boolean;
          credentialScope?: string;
          recoveryRequiredReason?: string;
        }>;
      }
    ).finishSuccessfulCodexLogin.bind(adapter);

    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({
      authenticated: true,
      recoveryRequiredReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });

    await adapter.verifyRecoveryWithAccountRpc(async () => undefined);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: CODEX_USER_DISCONNECT_REASON,
      credentialScope: 'instance-isolated',
      durableDisconnect: true,
    });

    const restartedAdapter = new DesktopCodexAuthAdapter();
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'instance-isolated',
    });
    expect(fs.readFileSync(localAuth, 'utf8')).not.toBe(fs.readFileSync(systemAuth, 'utf8'));
    expect(JSON.parse(fs.readFileSync(localAuth, 'utf8'))).toMatchObject({
      tokens: { access_token: 'new-cindy-token' },
    });
  });

  it('does not confirm an account probe after the active owner generation changes', async () => {
    const { adapter, codexHome } = await createRecoveryCandidate('instance-isolated');
    const accountRpc = deferred<string>();
    const verification = adapter.verifyRecoveryWithAccountRpc(() => accountRpc.promise);

    h.sessionGeneration += 1;
    accountRpc.resolve('usage-result');

    await expect(verification).resolves.toBe('usage-result');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('does not confirm an account probe after the local credential changes', async () => {
    const { adapter, codexHome, localAuth } = await createRecoveryCandidate('instance-isolated');
    const accountRpc = deferred<string>();
    const verification = adapter.verifyRecoveryWithAccountRpc(() => accountRpc.promise);

    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'newer-token', account_id: 'acct-1' } }),
    );
    accountRpc.resolve('usage-result');

    await expect(verification).resolves.toBe('usage-result');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('does not confirm an account probe while a new tracked login is pending', async () => {
    const { adapter, codexHome } = await createRecoveryCandidate('instance-isolated');
    const accountRpc = deferred<string>();
    const verification = adapter.verifyRecoveryWithAccountRpc(() => accountRpc.promise);
    const loginBarrier = deferred<void>();
    const startTrackedLogin = (
      adapter as unknown as {
        startTrackedLogin(
          opts?: undefined,
          waitFor?: Promise<unknown>,
        ): Promise<{ authenticated: boolean; errorReason?: string }>;
      }
    ).startTrackedLogin.bind(adapter);
    const login = startTrackedLogin(undefined, loginBarrier.promise);

    accountRpc.resolve('usage-result');

    await expect(verification).resolves.toBe('usage-result');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });

    adapter.cancelLogin();
    loginBarrier.resolve();
    await expect(login).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('does not confirm an account probe while an app-session boundary is pending', async () => {
    const { adapter, codexHome } = await createRecoveryCandidate('instance-isolated');
    const accountRpc = deferred<string>();
    const verification = adapter.verifyRecoveryWithAccountRpc(() => accountRpc.promise);

    h.sessionBoundaryPending = true;
    accountRpc.resolve('usage-result');

    await expect(verification).resolves.toBe('usage-result');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('does not consume a recovery marker created after an account probe starts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-late-recovery-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'system-token' } }));
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'local-token' } }));
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const accountRpc = deferred<string>();
    const verification = adapter.verifyRecoveryWithAccountRpc(() => accountRpc.promise);

    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);
    accountRpc.resolve('usage-result');

    await expect(verification).resolves.toBe('usage-result');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('returns account usage but keeps isolated recovery pending when sentinel persistence fails', async () => {
    const { adapter, codexHome, markerPath } = await createRecoveryCandidate('instance-isolated');
    const realRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === markerPath) throw new Error('EIO: marker rename failed');
      return realRenameSync(from, to);
    });

    await expect(adapter.verifyRecoveryWithAccountRpc(async () => 'usage-result')).resolves.toBe(
      'usage-result',
    );
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('returns account usage but keeps shared recovery pending when marker removal fails', async () => {
    const { adapter, codexHome, markerPath } = await createRecoveryCandidate('system-shared');
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file) === markerPath) throw new Error('EPERM: marker is locked');
      return realUnlinkSync(file);
    });

    await expect(adapter.verifyRecoveryWithAccountRpc(async () => 'usage-result')).resolves.toBe(
      'usage-result',
    );
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });
  });

  it('fails login finalization before rebinding when the recovered scope cannot be persisted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-scope-persist-fail-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const markerPath = getCodexAuthInvalidationMarkerPath(codexHome);
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'expired-system-token', account_id: 'acct-1' } }),
    );
    fs.linkSync(systemAuth, localAuth);
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-a' }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await adapter.getState({ credentialMode: 'oauth-bearer' });
    await adapter.invalidate('token_revoked');
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'new-cindy-token', account_id: 'acct-1' } }),
    );

    const realRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === markerPath) throw new Error('EIO: marker rename failed');
      return realRenameSync(from, to);
    });
    const finishSuccessfulCodexLogin = (
      adapter as unknown as {
        finishSuccessfulCodexLogin(): Promise<{ authenticated: boolean; errorReason?: string }>;
      }
    ).finishSuccessfulCodexLogin.bind(adapter);

    await expect(finishSuccessfulCodexLogin()).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_finalize_error:failed_to_persist_auth_boundary',
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('openai');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'system-shared',
    });
  });

  it('blocks every token read when a Windows lock leaves the disconnected local file behind', async () => {
    const { codexHome: fixtureCodexHome, systemAuth } = fixture();
    h.userDataDir = path.join(path.dirname(fixtureCodexHome), 'user-data');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'old@example.test' },
        tokens: { access_token: 'old-local-token', account_id: 'old-account' },
      }),
    );
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        CODEX_USER_DISCONNECT_REASON,
        localAuth,
      ),
    ).toBe(true);

    const realUnlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file) === localAuth) throw new Error('EPERM: file is locked');
      return realUnlinkSync(file);
    });
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toEqual({
      authenticated: false,
      errorReason: 'no_oauth',
    });
    await expect(adapter.getAccessToken()).resolves.toBeNull();
    await expect(adapter.getAccountId()).resolves.toBeNull();
    expect(readCodexOneShotCreds()).toBeNull();
    expect(fs.existsSync(localAuth)).toBe(true);
  });

  it('uses the ChatGPT workspace claim and never falls back account identity to JWT sub', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-workspace-id-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    fs.mkdirSync(codexHome, { recursive: true });

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        tokens: {
          access_token: 'local-token',
          id_token: idToken({ sub: 'user-subject' }),
        },
      }),
    );
    await expect(adapter.getAccountId()).resolves.toBeNull();

    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        tokens: {
          access_token: 'local-token',
          id_token: idToken({
            sub: 'user-subject',
            'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-actual' },
          }),
        },
      }),
    );
    await expect(adapter.getAccountId()).resolves.toBe('workspace-actual');
  });

  it('finishes logout cleanup after a durable disconnect when Windows keeps auth.json locked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-auth-logout-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const modelsCache = path.join(codexHome, 'models_cache.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'old-local-token', account_id: 'old-account' } }),
    );
    fs.writeFileSync(modelsCache, JSON.stringify({ models: [{ slug: 'old-account-model' }] }));

    const {
      clearCodexAuthBoundaryStateBeforeLogin,
      DesktopCodexAuthAdapter,
      readCodexOneShotCreds,
    } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(onLogoutSuccess);
    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(new Error('EPERM: file is locked'));

    await expect(adapter.logout()).resolves.toBeUndefined();
    expect(onLogoutSuccess).toHaveBeenCalledTimes(1);
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toEqual({
      authenticated: false,
      errorReason: 'no_oauth',
    });
    expect(readCodexOneShotCreds()).toBeNull();
    expect(fs.existsSync(localAuth)).toBe(true);
    expect(fs.existsSync(modelsCache)).toBe(false);

    // 文件仍锁定时登录前门禁 fail-closed；锁释放后的下一次重试会自动删掉残留。
    rmSpy.mockRejectedValueOnce(new Error('EPERM: file is still locked'));
    await expect(clearCodexAuthBoundaryStateBeforeLogin(codexHome)).resolves.toBe(false);
    expect(fs.existsSync(localAuth)).toBe(true);
    await expect(clearCodexAuthBoundaryStateBeforeLogin(codexHome)).resolves.toBe(true);
    expect(fs.existsSync(localAuth)).toBe(false);
  });

  it('rejects explicit logout when the provider binding mutation lock is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-auth-binding-lock-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    fs.mkdirSync(
      path.join(h.userDataDir, 'native-provider-auth.json.mutation-lock.db'),
      { recursive: true },
    );

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.logout()).rejects.toThrow(
      'failed to acquire native provider binding mutation lock',
    );
  });

  it('clears a pending recovery state when the user explicitly logs out', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-recovery-logout-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ openai: 'owner-a', selfAuthorized: { openai: 'owner-a' } }),
    );
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'expired-token' } }));
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        path.join(root, 'empty-home', '.codex', 'auth.json'),
        'token_revoked',
        localAuth,
        'instance-isolated',
      ),
    ).toBe(true);
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'replacement-token' } }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      recoveryRequiredReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });

    await expect(adapter.logout()).resolves.toBeUndefined();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toEqual({
      authenticated: false,
      errorReason: 'no_oauth',
    });
  });

  it('removes an unowned model cache before login and fails closed while it is locked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-model-cache-login-'));
    dirs.push(root);
    const codexHome = path.join(root, 'codex-home');
    const cachePath = path.join(codexHome, 'models_cache.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: 'old-account-model' }] }));

    const { clearCodexAuthBoundaryStateBeforeLogin } = await import('../auth-adapters.js');
    const rmSpy = vi.spyOn(fs.promises, 'rm');
    rmSpy.mockRejectedValueOnce(new Error('EPERM: model cache is locked'));

    await expect(clearCodexAuthBoundaryStateBeforeLogin(codexHome)).resolves.toBe(false);
    expect(fs.existsSync(cachePath)).toBe(true);
    await expect(clearCodexAuthBoundaryStateBeforeLogin(codexHome)).resolves.toBe(true);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('awaits the async invalidation finalizer after disk and host cleanup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-invalidation-finalizer-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const cachePath = path.join(codexHome, 'models_cache.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({
        openai: 'owner-a',
        selfAuthorized: { openai: 'owner-a' },
      }),
    );
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'expired-token' } }));
    fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: 'old-account-model' }] }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const order: string[] = [];
    let releaseFinalizer!: () => void;
    const finalizer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('finalizer-start');
          releaseFinalizer = () => {
            order.push('finalizer-end');
            resolve();
          };
        }),
    );
    adapter.setOnLogoutSuccess(async () => {
      order.push('host-disposed');
    });
    adapter.setOnInvalidatedBroadcast(finalizer);

    const invalidation = adapter.invalidate('token_invalidated');
    await vi.waitFor(() =>
      expect(finalizer).toHaveBeenCalledWith('token_invalidated', 'instance-isolated'),
    );
    expect(order).toEqual(['host-disposed', 'finalizer-start']);
    expect(fs.existsSync(localAuth)).toBe(false);
    expect(fs.existsSync(cachePath)).toBe(false);

    let settled = false;
    void invalidation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFinalizer();
    await expect(invalidation).resolves.toBeUndefined();
    expect(order).toEqual(['host-disposed', 'finalizer-start', 'finalizer-end']);
  });

  it('keeps invalidation recovery actionable when auth.json remains locked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-invalidation-locked-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const cachePath = path.join(codexHome, 'models_cache.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ openai: 'owner-a', selfAuthorized: { openai: 'owner-a' } }),
    );
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'expired-token', account_id: 'acct-1' } }),
    );
    fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: 'old-account-model' }] }));

    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(onLogoutSuccess);
    adapter.setOnInvalidatedBroadcast(broadcast);
    const realRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === localAuth) throw new Error('EPERM: auth is locked');
      return realRm(target, options);
    });

    await expect(adapter.invalidate('token_revoked')).resolves.toBeUndefined();
    expect(onLogoutSuccess).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith('token_revoked', 'instance-isolated');
    expect(fs.existsSync(localAuth)).toBe(true);
    expect(fs.existsSync(cachePath)).toBe(false);
    await expect(adapter.getAccessToken()).resolves.toBeNull();
    expect(readCodexOneShotCreds()).toBeNull();
  });

  it('fails closed when the invalidation marker cannot be committed and restores suppression after login', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-invalidation-marker-fail-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const markerPath = path.join(codexHome, 'auth-invalidated-system.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'system-token', account_id: 'acct-1' },
      }),
    );
    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'expired-local', account_id: 'acct-1' },
      }),
    );
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ openai: 'owner-a', selfAuthorized: { openai: 'owner-a' } }),
    );

    const realRenameSync = fs.renameSync.bind(fs);
    let failMarkerCommit = true;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failMarkerCommit && String(to) === markerPath) {
        failMarkerCommit = false;
        throw new Error('EIO: marker rename failed');
      }
      return realRenameSync(from, to);
    });
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnInvalidatedBroadcast(broadcast);

    await expect(adapter.invalidate('token_revoked')).resolves.toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith('token_revoked', 'unknown');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'native-provider-auth.json'), 'utf8')),
    ).toMatchObject({ revoked: { openai: 'owner-a' } });
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'unknown',
    });

    // Simulate a process restart: the coarse provider revocation must still block system reclaim
    // even though the richer codex-home marker never committed. A later explicit Cindy login then
    // proves that the replacement credential is instance-isolated.
    const restartedAdapter = new DesktopCodexAuthAdapter();
    await expect(restartedAdapter.getAccessToken()).resolves.toBeNull();
    expect(fs.existsSync(localAuth)).toBe(false);

    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'new-local-token', account_id: 'acct-1' },
      }),
    );
    const finishSuccessfulCodexLogin = (
      restartedAdapter as unknown as {
        finishSuccessfulCodexLogin(): Promise<{ authenticated: boolean }>;
      }
    ).finishSuccessfulCodexLogin.bind(restartedAdapter);
    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({
      authenticated: true,
      recoveryRequiredReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    expect(fs.readFileSync(localAuth, 'utf8')).not.toBe(fs.readFileSync(systemAuth, 'utf8'));
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toMatchObject({
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    await expect(restartedAdapter.getAccessToken()).resolves.toBe('new-local-token');
    await restartedAdapter.verifyRecoveryWithAccountRpc(async () => undefined);
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toMatchObject({
      reason: CODEX_USER_DISCONNECT_REASON,
      credentialScope: 'instance-isolated',
      durableDisconnect: true,
    });
  });

  it('lets explicit logout upgrade an invalidation already in progress', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-invalidation-logout-race-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ openai: 'owner-a', selfAuthorized: { openai: 'owner-a' } }),
    );
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'expired-token' } }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const cleanupGate = deferred();
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(() => cleanupGate.promise);
    adapter.setOnInvalidatedBroadcast(broadcast);

    const invalidation = adapter.invalidate('token_invalidated');
    await vi.waitFor(() => expect(fs.existsSync(localAuth)).toBe(false));
    const explicitLogout = adapter.logout();
    cleanupGate.resolve();

    await expect(invalidation).resolves.toBeUndefined();
    await expect(explicitLogout).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      getActiveInvalidatedSystemCodexAuthMarker(
        codexHome,
        path.join(root, 'empty-home', '.codex', 'auth.json'),
      ),
    ).toMatchObject({
      reason: CODEX_USER_DISCONNECT_REASON,
      durableDisconnect: true,
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { openai: 'owner-a' },
    });
  });

  it('keeps explicit logout authoritative when invalidation arrives during cleanup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-logout-invalidation-race-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ openai: 'owner-a', selfAuthorized: { openai: 'owner-a' } }),
    );
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'active-token' } }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const cleanupGate = deferred();
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(() => cleanupGate.promise);
    adapter.setOnInvalidatedBroadcast(broadcast);

    const explicitLogout = adapter.logout();
    await vi.waitFor(() => expect(fs.existsSync(localAuth)).toBe(false));
    const invalidation = adapter.invalidate('token_invalidated');
    cleanupGate.resolve();

    await expect(explicitLogout).resolves.toBeUndefined();
    await expect(invalidation).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      getActiveInvalidatedSystemCodexAuthMarker(
        codexHome,
        path.join(root, 'empty-home', '.codex', 'auth.json'),
      ),
    ).toMatchObject({
      reason: CODEX_USER_DISCONNECT_REASON,
      durableDisconnect: true,
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { openai: 'owner-a' },
    });
  });

  it('ignores a stale invalidation after explicit logout has already completed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-logout-stale-invalidation-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'empty-home'));
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ openai: 'owner-a', selfAuthorized: { openai: 'owner-a' } }),
    );
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'active-token' } }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnInvalidatedBroadcast(broadcast);

    await expect(adapter.logout()).resolves.toBeUndefined();
    await expect(adapter.invalidate('token_invalidated')).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      getActiveInvalidatedSystemCodexAuthMarker(
        codexHome,
        path.join(root, 'empty-home', '.codex', 'auth.json'),
      ),
    ).toMatchObject({
      reason: CODEX_USER_DISCONNECT_REASON,
      durableDisconnect: true,
    });
  });

  it('keeps a legacy reason-only disconnect authoritative over a late invalidation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-legacy-disconnect-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(systemAuth, JSON.stringify({ tokens: { access_token: 'old-token' } }));
    fs.linkSync(systemAuth, localAuth);
    const stat = fs.statSync(systemAuth);
    fs.writeFileSync(
      getCodexAuthInvalidationMarkerPath(codexHome),
      JSON.stringify({
        reason: CODEX_USER_DISCONNECT_REASON,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }),
    );

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const broadcast = vi.fn();
    adapter.setOnInvalidatedBroadcast(broadcast);

    await expect(adapter.invalidate('token_revoked')).resolves.toBeUndefined();
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: CODEX_USER_DISCONNECT_REASON,
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('remembers a shared source across atomic system replacement and reclaims the renewed login', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-shared-recovery-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-b';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'expired-system-token', account_id: 'acct-1' },
      }),
    );
    fs.linkSync(systemAuth, localAuth);
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ legacyClaimOwner: 'owner-a', openai: 'owner-b' }),
    );

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
      credentialScope: 'system-shared',
    });

    const replacement = path.join(path.dirname(systemAuth), 'auth.replacement.json');
    fs.writeFileSync(
      replacement,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'renewed-system-token', account_id: 'acct-1' },
      }),
    );
    fs.renameSync(replacement, systemAuth);
    expect(fs.readFileSync(localAuth, 'utf8')).not.toBe(fs.readFileSync(systemAuth, 'utf8'));

    const broadcast = vi.fn();
    adapter.setOnInvalidatedBroadcast(broadcast);
    await expect(adapter.invalidate('token_revoked')).resolves.toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith('token_revoked', 'system-shared');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      credentialScope: 'system-shared',
      recoveryOwnerId: 'owner-b',
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked.openai');

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
      credentialScope: 'system-shared',
      recoveryRequiredReason: 'token_revoked',
    });
    await expect(adapter.getAccessToken()).resolves.toBe('renewed-system-token');

    const restartedAdapter = new DesktopCodexAuthAdapter();
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
      credentialScope: 'system-shared',
      recoveryRequiredReason: 'token_revoked',
    });
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      recoveryOwnerId: 'owner-b',
    });

    await restartedAdapter.verifyRecoveryWithAccountRpc(async () => undefined);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      legacyClaimOwner: 'owner-a',
      openai: 'owner-b',
    });
  });

  it('real token invalidation still surfaces its reason when no replacement local credential exists', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    writeInvalidatedSystemCodexAuthMarker(
      codexHome,
      systemAuth,
      'token_invalidated',
      localAuth,
      'system-shared',
    );

    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: 'token_invalidated',
      credentialScope: 'system-shared',
    });
  });
});
