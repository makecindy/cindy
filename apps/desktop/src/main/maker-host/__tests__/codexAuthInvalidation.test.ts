import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_USER_DISCONNECT_REASON,
  currentCodexAuthFileFingerprint,
  getCodexAuthInvalidationMarkerPath,
  getActiveInvalidatedSystemCodexAuthMarker,
  readInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  settleInvalidationMarkerAfterLogin,
  shouldSuppressLocalCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
} from '../codex-auth-invalidation.js';

const dirs: string[] = [];
const expectedSharedLinkType = process.platform === 'win32' ? 'hardlink' : 'symlink';

/** 探测真实文件 symlink 能力；Windows 未启用 Developer Mode 时会返回 EPERM。 */
function canCreateFileSymlink(): boolean {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-invalidation-link-probe-'));
  try {
    const target = path.join(probeRoot, 'target');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, path.join(probeRoot, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const canLinkFile = canCreateFileSymlink();
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

function expectPlatformSharedLink(systemAuth: string, localAuth: string): void {
  expect(fs.lstatSync(localAuth).isSymbolicLink()).toBe(process.platform !== 'win32');
  const systemStat = fs.statSync(systemAuth);
  const localStat = fs.statSync(localAuth);
  expect({ dev: localStat.dev, ino: localStat.ino }).toEqual({
    dev: systemStat.dev,
    ino: systemStat.ino,
  });
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
      resolveWindowsAclPrincipal(
        { USERDOMAIN: 'WORKSTATION', USERNAME: 'DOMAIN\\alex' },
        'fallback',
      ),
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

  it('persists first explicit login provenance before reconciling a different system account', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-first-explicit-login-'));
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
        account: { email: 'system-a@example.test' },
        tokens: { access_token: 'system-a-token', account_id: 'account-a' },
      }),
    );
    fs.writeFileSync(
      localAuth,
      JSON.stringify({
        account: { email: 'cindy-b@example.test' },
        tokens: { access_token: 'cindy-b-token', account_id: 'account-b' },
      }),
    );

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const finishSuccessfulCodexLogin = (
      adapter as unknown as {
        finishSuccessfulCodexLogin(): Promise<{
          authenticated: boolean;
          credentialScope?: string;
        }>;
      }
    ).finishSuccessfulCodexLogin.bind(adapter);

    await expect(finishSuccessfulCodexLogin()).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'instance-isolated',
    });
    expect(JSON.parse(fs.readFileSync(localAuth, 'utf8'))).toMatchObject({
      account: { email: 'cindy-b@example.test' },
      tokens: { access_token: 'cindy-b-token', account_id: 'account-b' },
    });
    expect(JSON.parse(fs.readFileSync(systemAuth, 'utf8'))).toMatchObject({
      account: { email: 'system-a@example.test' },
      tokens: { access_token: 'system-a-token', account_id: 'account-a' },
    });
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      selfAuthorized: { openai: 'owner-a' },
      sources: { openai: 'explicit-provider-oauth' },
      instanceIsolatedCredential: { openai: 'owner-a' },
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
    fs.mkdirSync(path.join(h.userDataDir, 'native-provider-auth.json.mutation-lock.db'), {
      recursive: true,
    });

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

  it('persists unproven child suppression without modifying shared F2', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-unproven-child-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const markerPath = getCodexAuthInvalidationMarkerPath(codexHome);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
      { mode: 0o600 },
    );
    if (process.platform === 'win32') fs.linkSync(systemAuth, localAuth);
    else fs.symlinkSync(systemAuth, localAuth);
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({
        openai: 'owner-a',
        sharedSystemCredential: { openai: 'owner-a' },
      }),
    );
    const f2Bytes = fs.readFileSync(systemAuth);
    const f2Stat = fs.statSync(systemAuth);
    const rmSpy = vi.spyOn(fs.promises, 'rm');
    const chmodSpy = vi.spyOn(fs.promises, 'chmod');
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(onLogoutSuccess);
    adapter.setOnInvalidatedBroadcast(broadcast);

    await expect(
      adapter.invalidate('child_auth_rejected', { credentialAttribution: 'unproven' }),
    ).resolves.toBeUndefined();

    expect(onLogoutSuccess).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('child_auth_rejected', 'system-shared', false);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'child_auth_rejected',
      credentialScope: 'system-shared',
      recoveryOwnerId: 'owner-a',
      unprovenCredentialAttribution: true,
    });
    expect(rmSpy).not.toHaveBeenCalled();
    expect(chmodSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(systemAuth)).toEqual(f2Bytes);
    expect(fs.readFileSync(localAuth)).toEqual(f2Bytes);
    expect(fs.statSync(systemAuth)).toMatchObject({ ino: f2Stat.ino, mode: f2Stat.mode });
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'child_auth_rejected',
      credentialScope: 'system-shared',
    });

    const restartedAdapter = new DesktopCodexAuthAdapter();
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'child_auth_rejected',
      credentialScope: 'system-shared',
    });
    expect(fs.readFileSync(systemAuth)).toEqual(f2Bytes);
    expect(fs.readFileSync(localAuth)).toEqual(f2Bytes);

    rmSpy.mockRestore();
    const replacement = path.join(path.dirname(systemAuth), 'auth.f3.json');
    fs.writeFileSync(
      replacement,
      JSON.stringify({ tokens: { access_token: 'system-f3-token', account_id: 'acct-1' } }),
      { mode: 0o600 },
    );
    fs.renameSync(replacement, systemAuth);
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      recoveryRequiredReason: 'child_auth_rejected',
    });
    await expect(restartedAdapter.getAccessToken()).resolves.toBe('system-f3-token');
    await restartedAdapter.verifyRecoveryWithAccountRpc(async () => undefined);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(chmodSpy).not.toHaveBeenCalled();
  });

  it('keeps unproven shared suppression across restart when marker commit fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-unproven-marker-fail-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const markerPath = getCodexAuthInvalidationMarkerPath(codexHome);
    const bindingPath = path.join(h.userDataDir, 'native-provider-auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
      { mode: 0o600 },
    );
    if (process.platform === 'win32') fs.linkSync(systemAuth, localAuth);
    else fs.symlinkSync(systemAuth, localAuth);
    fs.writeFileSync(
      bindingPath,
      JSON.stringify({
        openai: 'owner-a',
        sharedSystemCredential: { openai: 'owner-a' },
        sources: { openai: 'native-harness-inherited' },
      }),
    );
    const f2Bytes = fs.readFileSync(systemAuth);
    const f2Stat = fs.statSync(systemAuth);
    const realRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === markerPath) throw new Error('EIO: marker rename failed');
      return realRenameSync(from, to);
    });
    const rm = vi.spyOn(fs.promises, 'rm');
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const broadcast = vi.fn();
    adapter.setOnInvalidatedBroadcast(broadcast);

    await adapter.invalidate('child_auth_rejected', { credentialAttribution: 'unproven' });

    expect(broadcast).toHaveBeenCalledWith('child_auth_rejected', 'unknown', false);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingPath, 'utf8'))).toMatchObject({
      revoked: { openai: 'owner-a' },
    });
    expect(fs.readFileSync(systemAuth)).toEqual(f2Bytes);
    expect(fs.readFileSync(localAuth)).toEqual(f2Bytes);
    expect(fs.statSync(systemAuth)).toMatchObject({ ino: f2Stat.ino, mode: f2Stat.mode });
    expect(rm).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();

    const restartedAdapter = new DesktopCodexAuthAdapter();
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({ authenticated: false });
    await expect(restartedAdapter.getAccessToken()).resolves.toBeNull();
    expect(readCodexOneShotCreds(restartedAdapter)).toBeNull();
    expect(JSON.parse(fs.readFileSync(bindingPath, 'utf8'))).toMatchObject({
      revoked: { openai: 'owner-a' },
    });
    expect(fs.readFileSync(systemAuth)).toEqual(f2Bytes);
    expect(fs.readFileSync(localAuth)).toEqual(f2Bytes);
    expect(rm).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
  });

  it('keeps an unproven isolated boundary until the local credential changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-unproven-isolated-'));
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
      JSON.stringify({ tokens: { access_token: 'system-token', account_id: 'acct-system' } }),
    );
    const localF2 = JSON.stringify({
      tokens: { access_token: 'isolated-f2-token', account_id: 'acct-local' },
    });
    fs.writeFileSync(localAuth, localF2);
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({
        openai: 'owner-a',
        selfAuthorized: { openai: 'owner-a' },
        sources: { openai: 'explicit-provider-oauth' },
        instanceIsolatedCredential: { openai: 'owner-a' },
      }),
    );
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await adapter.invalidate('isolated_child_auth_rejected', {
      credentialAttribution: 'unproven',
    });
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'isolated_child_auth_rejected',
      credentialScope: 'instance-isolated',
      unprovenCredentialAttribution: true,
    });

    const restartedAdapter = new DesktopCodexAuthAdapter();
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({ authenticated: false, errorReason: 'isolated_child_auth_rejected' });

    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-f3-token', account_id: 'acct-system' } }),
    );
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({ authenticated: false, errorReason: 'isolated_child_auth_rejected' });
    expect(fs.readFileSync(localAuth, 'utf8')).toBe(localF2);

    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'isolated-f3-token', account_id: 'acct-local' } }),
    );
    await expect(
      restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'instance-isolated',
      recoveryRequiredReason: 'isolated_child_auth_rejected',
    });
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
    const expiredGeneration = adapter.captureCredentialGeneration();
    expect(expiredGeneration).not.toBeNull();
    expectPlatformSharedLink(systemAuth, localAuth);

    const replacement = path.join(path.dirname(systemAuth), 'auth.replacement.json');
    fs.writeFileSync(
      replacement,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'renewed-system-token', account_id: 'acct-1' },
      }),
    );
    fs.renameSync(replacement, systemAuth);
    if (process.platform === 'win32') {
      expect(fs.readFileSync(localAuth, 'utf8')).not.toBe(fs.readFileSync(systemAuth, 'utf8'));
    } else {
      expect(fs.readFileSync(localAuth, 'utf8')).toBe(fs.readFileSync(systemAuth, 'utf8'));
    }

    const broadcast = vi.fn();
    adapter.setOnInvalidatedBroadcast(broadcast);
    await expect(
      adapter.invalidate('token_revoked', { credentialGeneration: expiredGeneration }),
    ).resolves.toBeUndefined();
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked.openai');
    const restartedAdapter = new DesktopCodexAuthAdapter();
    if (process.platform === 'win32') {
      // Windows local 仍是 F1 旧 hardlink，generation 匹配；清掉 F1 后从 system F2 恢复。
      expect(broadcast).toHaveBeenCalledWith('token_revoked', 'system-shared');
      expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
        credentialScope: 'system-shared',
        recoveryOwnerId: 'owner-b',
      });
      await expect(
        restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
      ).resolves.toMatchObject({
        authenticated: true,
        authSource: 'oauth',
        credentialScope: 'system-shared',
        recoveryRequiredReason: 'token_revoked',
      });
      await restartedAdapter.verifyRecoveryWithAccountRpc(async () => undefined);
      expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
    } else {
      // POSIX symlink 已跟到 F2；F1 迟到 invalidation 不能碰当前凭证或制造恢复态。
      expect(broadcast).not.toHaveBeenCalled();
      expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
      await expect(
        restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
      ).resolves.toMatchObject({
        authenticated: true,
        authSource: 'oauth',
        credentialScope: 'system-shared',
      });
    }
    await expect(restartedAdapter.getAccessToken()).resolves.toBe('renewed-system-token');
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      legacyClaimOwner: 'owner-a',
      openai: 'owner-b',
    });
  });

  it('repairs a pre-upgrade Windows hardlink rotated before provenance migration', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-windows-shared-rotation-'));
      dirs.push(root);
      h.userDataDir = path.join(root, 'user-data');
      h.dataOwnerId = 'owner-a';
      const home = path.join(root, 'home');
      const systemAuth = path.join(home, '.codex', 'auth.json');
      const codexHome = path.join(h.userDataDir, 'codex-home');
      const localAuth = path.join(codexHome, 'auth.json');
      const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      const chmodSpy = vi.spyOn(fs.promises, 'chmod');
      fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        systemAuth,
        JSON.stringify({ tokens: { access_token: 'system-f1-token', account_id: 'acct-1' } }),
        { mode: 0o600 },
      );
      fs.linkSync(systemAuth, localAuth);
      fs.mkdirSync(h.userDataDir, { recursive: true });
      fs.writeFileSync(
        bindingFile,
        JSON.stringify({
          openai: 'owner-a',
          selfAuthorized: { openai: 'owner-a' },
          sources: { openai: 'explicit-provider-oauth' },
        }),
      );

      const replacement = path.join(path.dirname(systemAuth), 'auth.f2.json');
      fs.writeFileSync(
        replacement,
        JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
        { mode: 0o600 },
      );
      fs.renameSync(replacement, systemAuth);
      expect(fs.readFileSync(localAuth, 'utf8')).toContain('system-f1-token');
      const systemBeforeReconcile = fs.readFileSync(systemAuth);
      const systemStatBeforeReconcile = fs.statSync(systemAuth);

      const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
      await expect(
        new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' }),
      ).resolves.toMatchObject({
        authenticated: true,
        credentialScope: 'system-shared',
        credentialDiagnostics: {
          linkType: 'hardlink',
          healthy: true,
          orphanRepair: 'relinked',
        },
      });

      expect(fs.readFileSync(localAuth, 'utf8')).toContain('system-f2-token');
      expect(fs.readFileSync(localAuth, 'utf8')).not.toContain('system-f1-token');
      const localStat = fs.statSync(localAuth);
      const systemStatAfterReconcile = fs.statSync(systemAuth);
      expect({ dev: localStat.dev, ino: localStat.ino }).toEqual({
        dev: systemStatAfterReconcile.dev,
        ino: systemStatAfterReconcile.ino,
      });
      expect(fs.readFileSync(systemAuth)).toEqual(systemBeforeReconcile);
      expect({
        dev: systemStatAfterReconcile.dev,
        ino: systemStatAfterReconcile.ino,
        mode: systemStatAfterReconcile.mode,
      }).toEqual({
        dev: systemStatBeforeReconcile.dev,
        ino: systemStatBeforeReconcile.ino,
        mode: systemStatBeforeReconcile.mode,
      });
      expect(chmodSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('repairs a pre-upgrade POSIX hardlink rotated before provenance migration', async ({ skip }) => {
    if (!canLinkFile) skip();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-posix-shared-rotation-'));
      dirs.push(root);
      h.userDataDir = path.join(root, 'user-data');
      h.dataOwnerId = 'owner-a';
      const home = path.join(root, 'home');
      const systemAuth = path.join(home, '.codex', 'auth.json');
      const localAuth = path.join(h.userDataDir, 'codex-home', 'auth.json');
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      const chmodSpy = vi.spyOn(fs.promises, 'chmod');
      fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
      fs.mkdirSync(path.dirname(localAuth), { recursive: true });
      fs.writeFileSync(
        systemAuth,
        JSON.stringify({ tokens: { access_token: 'system-f1-token', account_id: 'acct-1' } }),
        { mode: 0o600 },
      );
      fs.linkSync(systemAuth, localAuth);
      fs.writeFileSync(
        path.join(h.userDataDir, 'native-provider-auth.json'),
        JSON.stringify({
          openai: 'owner-a',
          selfAuthorized: { openai: 'owner-a' },
          sources: { openai: 'explicit-provider-oauth' },
        }),
      );

      const replacement = path.join(path.dirname(systemAuth), 'auth.f2.json');
      fs.writeFileSync(
        replacement,
        JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
        { mode: 0o600 },
      );
      fs.renameSync(replacement, systemAuth);
      expect(fs.readFileSync(localAuth, 'utf8')).toContain('system-f1-token');
      const systemBeforeReconcile = fs.readFileSync(systemAuth);
      const systemStatBeforeReconcile = fs.statSync(systemAuth);

      const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
      await expect(
        new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' }),
      ).resolves.toMatchObject({
        authenticated: true,
        credentialScope: 'system-shared',
        credentialDiagnostics: { linkType: 'symlink', healthy: true, orphanRepair: 'relinked' },
      });

      expect(fs.lstatSync(localAuth).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(localAuth, 'utf8')).toContain('system-f2-token');
      expect(fs.readFileSync(localAuth, 'utf8')).not.toContain('system-f1-token');
      expect(fs.readFileSync(systemAuth)).toEqual(systemBeforeReconcile);
      expect(fs.statSync(systemAuth)).toMatchObject({
        ino: systemStatBeforeReconcile.ino,
        mode: systemStatBeforeReconcile.mode,
      });
      expect(chmodSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it.each([
    { platform: 'darwin', label: 'POSIX' },
    { platform: 'win32', label: 'Windows' },
  ])('preserves a parent-version explicit isolated account on $label', async ({ platform }) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-legacy-explicit-'));
      dirs.push(root);
      h.userDataDir = path.join(root, 'user-data');
      h.dataOwnerId = 'owner-a';
      const home = path.join(root, 'home');
      const systemAuth = path.join(home, '.codex', 'auth.json');
      const localAuth = path.join(h.userDataDir, 'codex-home', 'auth.json');
      const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      const chmodSpy = vi.spyOn(fs.promises, 'chmod');
      fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
      fs.mkdirSync(path.dirname(localAuth), { recursive: true });
      fs.writeFileSync(
        systemAuth,
        JSON.stringify({ tokens: { access_token: 'system-a-token', account_id: 'account-a' } }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        localAuth,
        JSON.stringify({ tokens: { access_token: 'cindy-b-token', account_id: 'account-b' } }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        bindingFile,
        JSON.stringify({
          openai: 'owner-a',
          selfAuthorized: { openai: 'owner-a' },
          sources: { openai: 'explicit-provider-oauth' },
        }),
      );
      const localBefore = fs.readFileSync(localAuth);
      const localStatBefore = fs.statSync(localAuth);
      const systemBefore = fs.readFileSync(systemAuth);
      const systemStatBefore = fs.statSync(systemAuth);

      const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
      const adapter = new DesktopCodexAuthAdapter();
      await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
        authenticated: true,
        credentialScope: 'instance-isolated',
      });
      await expect(adapter.getAccessToken()).resolves.toBe('cindy-b-token');

      expect(fs.readFileSync(localAuth)).toEqual(localBefore);
      expect(fs.statSync(localAuth)).toMatchObject({
        ino: localStatBefore.ino,
        mode: localStatBefore.mode,
      });
      expect(fs.readFileSync(systemAuth)).toEqual(systemBefore);
      expect(fs.statSync(systemAuth)).toMatchObject({
        ino: systemStatBefore.ino,
        mode: systemStatBefore.mode,
      });
      expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
        openai: 'owner-a',
        selfAuthorized: { openai: 'owner-a' },
        sources: { openai: 'explicit-provider-oauth' },
        instanceIsolatedCredential: { openai: 'owner-a' },
      });
      expect(chmodSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  async function assertDetachedSharedF1Invalidation(platform: 'darwin' | 'win32'): Promise<void> {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-shared-provenance-'));
      dirs.push(root);
      h.userDataDir = path.join(root, 'user-data');
      h.dataOwnerId = 'owner-a';
      const home = path.join(root, 'home');
      const systemAuth = path.join(home, '.codex', 'auth.json');
      const codexHome = path.join(h.userDataDir, 'codex-home');
      const localAuth = path.join(codexHome, 'auth.json');
      const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      const chmodSpy = vi.spyOn(fs.promises, 'chmod');
      fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        systemAuth,
        JSON.stringify({ tokens: { access_token: 'system-f1-token', account_id: 'acct-1' } }),
        { mode: 0o600 },
      );
      fs.linkSync(systemAuth, localAuth);
      fs.writeFileSync(
        bindingFile,
        JSON.stringify({
          openai: 'owner-a',
          selfAuthorized: { openai: 'owner-a' },
          sources: { openai: 'explicit-provider-oauth' },
          sharedSystemCredential: { openai: 'owner-a' },
        }),
      );

      const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
      const adapter = new DesktopCodexAuthAdapter();
      const f1Fingerprint = currentCodexAuthFileFingerprint(localAuth);
      const f1Generation = adapter.captureCredentialGeneration();
      expect(f1Fingerprint).not.toBeNull();
      expect(f1Generation).not.toBeNull();

      const replacement = path.join(path.dirname(systemAuth), 'auth.f2.json');
      fs.writeFileSync(
        replacement,
        JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
        { mode: 0o600 },
      );
      fs.renameSync(replacement, systemAuth);
      const systemF2Before = fs.readFileSync(systemAuth);
      const systemF2StatBefore = fs.statSync(systemAuth);
      const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
      const broadcast = vi.fn().mockResolvedValue(undefined);
      adapter.setOnLogoutSuccess(onLogoutSuccess);
      adapter.setOnInvalidatedBroadcast(broadcast);

      await expect(
        adapter.invalidate('late_f1_401', { credentialGeneration: f1Generation }),
      ).resolves.toBeUndefined();

      expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
        reason: 'late_f1_401',
        credentialScope: 'system-shared',
        recoveryOwnerId: 'owner-a',
        sha256: f1Fingerprint!.sha256,
      });
      expect(onLogoutSuccess).toHaveBeenCalledOnce();
      expect(broadcast).toHaveBeenCalledWith('late_f1_401', 'system-shared');
      expect(fs.readFileSync(systemAuth)).toEqual(systemF2Before);
      expect(fs.statSync(systemAuth)).toMatchObject({
        ino: systemF2StatBefore.ino,
        mode: systemF2StatBefore.mode,
      });

      const restartedAdapter = new DesktopCodexAuthAdapter();
      await expect(
        restartedAdapter.getState({ credentialMode: 'oauth-bearer' }),
      ).resolves.toMatchObject({
        authenticated: true,
        credentialScope: 'system-shared',
        recoveryRequiredReason: 'late_f1_401',
      });
      expectPlatformSharedLink(systemAuth, localAuth);
      await expect(restartedAdapter.getAccessToken()).resolves.toBe('system-f2-token');
      await restartedAdapter.verifyRecoveryWithAccountRpc(async () => undefined);
      expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
      expect(fs.readFileSync(systemAuth)).toEqual(systemF2Before);
      expect(chmodSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  }

  it.skipIf(!canLinkFile)('attributes a detached shared F1 invalidation on POSIX', async () => {
    await assertDetachedSharedF1Invalidation('darwin');
  });

  it('attributes a detached shared F1 invalidation on Windows', async () => {
    await assertDetachedSharedF1Invalidation('win32');
  });

  it('tracks a consumed symlink target generation until a later system replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-shared-generation-'));
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
        tokens: { access_token: 'system-f1-token', account_id: 'acct-1' },
      }),
    );
    fs.linkSync(systemAuth, localAuth);
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-b' }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getAccessToken()).resolves.toBe('system-f1-token');
    expectPlatformSharedLink(systemAuth, localAuth);

    const f2Replacement = path.join(path.dirname(systemAuth), 'auth.f2.json');
    fs.writeFileSync(
      f2Replacement,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'system-f2-token', account_id: 'acct-1' },
      }),
    );
    fs.renameSync(f2Replacement, systemAuth);
    // Crossing the healthy shared reconcile boundary proves F2 is now the consumed generation.
    await expect(adapter.getAccessToken()).resolves.toBe('system-f2-token');
    const f2Fingerprint = currentCodexAuthFileFingerprint(systemAuth);
    const f2Generation = adapter.captureCredentialGeneration();
    expect(f2Fingerprint).not.toBeNull();
    expect(f2Generation).not.toBeNull();

    await expect(
      adapter.invalidate('token_revoked', { credentialGeneration: f2Generation }),
    ).resolves.toBeUndefined();
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      credentialScope: 'system-shared',
      sha256: f2Fingerprint!.sha256,
    });
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).not.toBeNull();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    await expect(adapter.getAccessToken()).resolves.toBeNull();

    const f3Replacement = path.join(path.dirname(systemAuth), 'auth.f3.json');
    fs.writeFileSync(
      f3Replacement,
      JSON.stringify({
        account: { email: 'user@example.test' },
        tokens: { access_token: 'system-f3-token', account_id: 'acct-1' },
      }),
    );
    fs.renameSync(f3Replacement, systemAuth);
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
      credentialScope: 'system-shared',
      recoveryRequiredReason: 'token_revoked',
    });
    await expect(adapter.getAccessToken()).resolves.toBe('system-f3-token');
  });

  it('ignores a late shared-host invalidation across lossless Windows file IDs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-host-generation-'));
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
      JSON.stringify({ tokens: { access_token: 'system-f1-token', account_id: 'acct-1' } }),
    );
    fs.linkSync(systemAuth, localAuth);
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-b' }));

    const realFstatSync = fs.fstatSync.bind(fs);
    const realStatSync = fs.statSync.bind(fs);
    let exactIno = 9_007_199_254_740_992n;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => ({
      ...realFstatSync(fd, { bigint: true }),
      ino: exactIno,
    })) as typeof fs.fstatSync);
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (
        typeof options === 'object' &&
        options !== null &&
        'bigint' in options &&
        (options as { bigint?: boolean }).bigint
      ) {
        return realStatSync(target, { bigint: true });
      }
      const stat = realStatSync(target);
      return path.resolve(String(target)) === path.resolve(localAuth)
        ? { ...stat, ino: Number(exactIno) }
        : stat;
    }) as typeof fs.statSync);

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getAccessToken()).resolves.toBe('system-f1-token');
    const f1Fingerprint = currentCodexAuthFileFingerprint(localAuth);
    const f1Generation = adapter.captureCredentialGeneration();
    expect(f1Fingerprint).not.toBeNull();
    expect(f1Generation).not.toBeNull();
    expect(JSON.parse(f1Generation!).ino).toBe('9007199254740992');

    const f2Replacement = path.join(path.dirname(systemAuth), 'auth.f2.json');
    fs.writeFileSync(
      f2Replacement,
      JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
    );
    fs.renameSync(f2Replacement, systemAuth);
    exactIno = 9_007_199_254_740_993n;
    expect(Number(9_007_199_254_740_992n)).toBe(Number(exactIno));
    const f2Before = fs.readFileSync(systemAuth);
    const f2StatBefore = fs.statSync(systemAuth);
    const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(onLogoutSuccess);
    adapter.setOnInvalidatedBroadcast(broadcast);

    await Promise.all([
      adapter.getState({ credentialMode: 'oauth-bearer' }),
      adapter.getAccessToken(),
    ]);
    await expect(
      adapter.invalidate('late_f1_401', { credentialGeneration: f1Generation }),
    ).resolves.toBeUndefined();

    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
    expect(getActiveInvalidatedSystemCodexAuthMarker(codexHome, systemAuth)).toBeNull();
    expect(onLogoutSuccess).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
    });
    await expect(adapter.getAccessToken()).resolves.toBe('system-f2-token');
    expect(fs.readFileSync(systemAuth)).toEqual(f2Before);
    const f2StatAfter = fs.statSync(systemAuth);
    expect({ dev: f2StatAfter.dev, ino: f2StatAfter.ino, mode: f2StatAfter.mode }).toEqual({
      dev: f2StatBefore.dev,
      ino: f2StatBefore.ino,
      mode: f2StatBefore.mode,
    });
  });

  it.each([
    { identity: 'same inode', zeroInode: false },
    { identity: 'zero inode', zeroInode: true },
  ])('fails closed when a host credential rotates in place with $identity', async ({
    zeroInode,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-in-place-generation-'));
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
      JSON.stringify({ tokens: { access_token: 'system-f1-token', account_id: 'acct-1' } }),
    );
    fs.linkSync(systemAuth, localAuth);
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-b' }));

    if (zeroInode) {
      const realFstatSync = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => ({
        ...realFstatSync(fd, { bigint: true }),
        ino: 0n,
      })) as typeof fs.fstatSync);
    }

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const f1Generation = adapter.captureCredentialGeneration();
    const f1Stat = fs.statSync(systemAuth);
    expect(f1Generation).not.toBeNull();
    if (zeroInode) expect(JSON.parse(f1Generation!).ino).toBe('0');

    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-f2-token', account_id: 'acct-1' } }),
    );
    const f2Bytes = fs.readFileSync(systemAuth);
    const f2Stat = fs.statSync(systemAuth);
    expect({ dev: f2Stat.dev, ino: f2Stat.ino }).toEqual({ dev: f1Stat.dev, ino: f1Stat.ino });
    const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLogoutSuccess(onLogoutSuccess);
    adapter.setOnInvalidatedBroadcast(broadcast);

    await adapter.invalidate('f2_token_revoked', { credentialGeneration: f1Generation });

    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toMatchObject({
      reason: 'f2_token_revoked',
      credentialScope: 'unknown',
    });
    expect(onLogoutSuccess).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith('f2_token_revoked', 'unknown');
    expect(fs.existsSync(localAuth)).toBe(false);
    expect(fs.readFileSync(systemAuth)).toEqual(f2Bytes);
    const systemAfter = fs.statSync(systemAuth);
    expect({ dev: systemAfter.dev, ino: systemAfter.ino, mode: systemAfter.mode }).toEqual({
      dev: f2Stat.dev,
      ino: f2Stat.ino,
      mode: f2Stat.mode,
    });
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'f2_token_revoked',
      credentialScope: 'unknown',
    });
    await expect(adapter.getAccessToken()).resolves.toBeNull();
  });

  it('preserves an in-flight Cindy F2 login when an F1 host reports a late invalidation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-stale-host-login-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    const cachePath = path.join(codexHome, 'models_cache.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(h.userDataDir, { recursive: true });
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'host-f1-token', account_id: 'acct-1' } }),
    );
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-a' }));

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const f1Generation = adapter.captureCredentialGeneration();
    expect(f1Generation).not.toBeNull();

    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'cindy-f2-token', account_id: 'acct-2' } }),
    );
    const loginFinalizeGate = deferred();
    const onLoginSuccess = vi.fn(() => loginFinalizeGate.promise);
    const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    adapter.setOnLoginSuccess(onLoginSuccess);
    adapter.setOnLogoutSuccess(onLogoutSuccess);
    adapter.setOnInvalidatedBroadcast(broadcast);
    const finishSuccessfulCodexLogin = (
      adapter as unknown as {
        finishSuccessfulCodexLogin(): Promise<{ authenticated: boolean; credentialScope?: string }>;
      }
    ).finishSuccessfulCodexLogin.bind(adapter);
    (adapter as unknown as { loginCancellationOpen: boolean }).loginCancellationOpen = true;
    const loginFinalization = finishSuccessfulCodexLogin();
    await vi.waitFor(() => expect(onLoginSuccess).toHaveBeenCalledOnce());
    fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: 'f2-model' }] }));
    const f2Before = fs.readFileSync(localAuth);

    await expect(
      adapter.invalidate('late_f1_401', { credentialGeneration: f1Generation }),
    ).resolves.toBeUndefined();

    expect(fs.readFileSync(localAuth)).toEqual(f2Before);
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
    expect(onLogoutSuccess).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      selfAuthorized: { openai: 'owner-a' },
      sources: { openai: 'explicit-provider-oauth' },
    });

    loginFinalizeGate.resolve();
    await expect(loginFinalization).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'instance-isolated',
    });
    await expect(adapter.getAccessToken()).resolves.toBe('cindy-f2-token');
  });

  it.each([
    { platform: 'darwin', label: 'POSIX' },
    { platform: 'win32', label: 'Windows' },
  ])('preserves a tracked login when an F1 host fails during the $label cleanup window', async ({
    platform,
  }) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-login-cleanup-race-'));
      dirs.push(root);
      h.userDataDir = path.join(root, 'user-data');
      h.dataOwnerId = 'owner-a';
      const codexHome = path.join(h.userDataDir, 'codex-home');
      const localAuth = path.join(codexHome, 'auth.json');
      const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
      fs.mkdirSync(codexHome, { recursive: true });
      fs.mkdirSync(h.userDataDir, { recursive: true });
      fs.writeFileSync(
        localAuth,
        JSON.stringify({ tokens: { access_token: 'host-f1-token', account_id: 'acct-1' } }),
      );
      fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-a' }));

      const { clearCodexAuthBoundaryStateBeforeLogin, DesktopCodexAuthAdapter } = await import(
        '../auth-adapters.js'
      );
      const adapter = new DesktopCodexAuthAdapter();
      const f1Generation = adapter.captureCredentialGeneration();
      expect(f1Generation).not.toBeNull();
      await expect(
        clearCodexAuthBoundaryStateBeforeLogin(codexHome, { forceRemoveAuth: true }),
      ).resolves.toBe(true);
      expect(fs.existsSync(localAuth)).toBe(false);

      const loginGate = deferred<{ authenticated: boolean }>();
      const trackedLogin = { promise: loginGate.promise, cancelled: false };
      const privateState = adapter as unknown as {
        pendingLogin: typeof trackedLogin | null;
        loginCancellationOpen: boolean;
      };
      privateState.pendingLogin = trackedLogin;
      privateState.loginCancellationOpen = true;
      const onLogoutSuccess = vi.fn().mockResolvedValue(undefined);
      const broadcast = vi.fn().mockResolvedValue(undefined);
      const chmodSpy = vi.spyOn(fs.promises, 'chmod');
      adapter.setOnLogoutSuccess(onLogoutSuccess);
      adapter.setOnInvalidatedBroadcast(broadcast);

      const invalidation = adapter.invalidate('late_f1_401', {
        credentialGeneration: f1Generation,
      });
      const f2Bytes = Buffer.from(
        JSON.stringify({ tokens: { access_token: 'cindy-f2-token', account_id: 'acct-2' } }),
      );
      fs.writeFileSync(localAuth, f2Bytes);
      loginGate.resolve({ authenticated: true });
      await expect(invalidation).resolves.toBeUndefined();

      expect(trackedLogin.cancelled).toBe(false);
      expect(fs.readFileSync(localAuth)).toEqual(f2Bytes);
      expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
      expect(onLogoutSuccess).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(chmodSpy).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
        openai: 'owner-a',
      });
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('does not apply a stale orphan reconcile after a login writes local auth', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-login-reconcile-race-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const localAuth = path.join(h.userDataDir, 'codex-home', 'auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(path.dirname(localAuth), { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-a-token', account_id: 'acct-a' } }),
    );

    const originalReadFile = fs.promises.readFile;
    const systemReadStarted = deferred();
    const continueSystemRead = deferred();
    let heldSystemRead = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (!heldSystemRead && path.resolve(String(target)) === path.resolve(systemAuth)) {
        heldSystemRead = true;
        systemReadStarted.resolve();
        return continueSystemRead.promise.then(() =>
          (originalReadFile as (...args: unknown[]) => unknown)(target, ...rest),
        );
      }
      return (originalReadFile as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.promises.readFile);

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const reconcile = (
      adapter as unknown as { reconcileWithSystemCodex(): Promise<void> }
    ).reconcileWithSystemCodex.bind(adapter);
    const inFlightReconcile = reconcile();
    await systemReadStarted.promise;

    (adapter as unknown as { loginCancellationOpen: boolean }).loginCancellationOpen = true;
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'cindy-b-token', account_id: 'acct-b' } }),
    );
    const localBeforeResume = fs.readFileSync(localAuth);
    const systemBeforeResume = fs.readFileSync(systemAuth);
    continueSystemRead.resolve();
    await inFlightReconcile;

    expect(fs.readFileSync(localAuth)).toEqual(localBeforeResume);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBeforeResume);
    expect(fs.lstatSync(localAuth).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(h.userDataDir, 'native-provider-auth.json'))).toBe(false);
  });

  it('repairs an unproven local auth orphan instead of preserving its refresh token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-orphan-repair-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const localAuth = path.join(h.userDataDir, 'codex-home', 'auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(path.dirname(localAuth), { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-token', account_id: 'system-account' } }),
    );
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'orphan-token', account_id: 'old-account' } }),
    );
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({
        openai: 'owner-a',
        sources: { openai: 'native-harness-inherited' },
      }),
    );

    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const state = await new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' });

    expect(state).toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      credentialDiagnostics: {
        linkType: expectedSharedLinkType,
        healthy: true,
        orphanRepair: 'relinked',
      },
    });
    expectPlatformSharedLink(systemAuth, localAuth);
    expect(fs.readFileSync(localAuth, 'utf8')).toContain('system-token');
  });

  it('preserves explicit isolated auth across owner A to B to A without exposing it to B', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-isolated-preserve-'));
    dirs.push(root);
    h.userDataDir = path.join(root, 'user-data');
    h.dataOwnerId = 'owner-a';
    const home = path.join(root, 'home');
    const systemAuth = path.join(home, '.codex', 'auth.json');
    const localAuth = path.join(h.userDataDir, 'codex-home', 'auth.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
    fs.mkdirSync(path.dirname(localAuth), { recursive: true });
    fs.writeFileSync(
      systemAuth,
      JSON.stringify({ tokens: { access_token: 'system-token', account_id: 'system-account' } }),
    );
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'isolated-token', account_id: 'other-account' } }),
    );
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({
        openai: 'owner-a',
        selfAuthorized: { openai: 'owner-a' },
        sources: { openai: 'explicit-provider-oauth' },
        instanceIsolatedCredential: { openai: 'owner-a' },
      }),
    );

    const bindingFile = path.join(h.userDataDir, 'native-provider-auth.json');
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const ownerAAdapter = new DesktopCodexAuthAdapter();
    const state = await ownerAAdapter.getState({ credentialMode: 'oauth-bearer' });

    expect(state).toMatchObject({
      authenticated: true,
      credentialScope: 'instance-isolated',
      credentialDiagnostics: {
        linkType: 'file',
        healthy: true,
        orphanRepair: 'none',
      },
    });
    expect(fs.lstatSync(localAuth).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(localAuth, 'utf8')).toContain('isolated-token');
    await expect(ownerAAdapter.getAccessToken()).resolves.toBe('isolated-token');

    const localBeforeSwitch = fs.readFileSync(localAuth);
    const systemBeforeSwitch = fs.readFileSync(systemAuth);
    const systemStatBeforeSwitch = fs.statSync(systemAuth);
    h.dataOwnerId = 'owner-b';
    h.sessionGeneration += 1;
    const ownerBAdapter = new DesktopCodexAuthAdapter();

    await expect(ownerBAdapter.getState()).resolves.toEqual({
      authenticated: false,
      errorReason: 'oauth_not_bound',
    });
    await expect(ownerBAdapter.getAccessToken()).resolves.toBeNull();
    expect(fs.readFileSync(localAuth)).toEqual(localBeforeSwitch);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBeforeSwitch);
    expect(fs.statSync(systemAuth).ino).toBe(systemStatBeforeSwitch.ino);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      selfAuthorized: { openai: 'owner-a' },
      sources: { openai: 'explicit-provider-oauth' },
    });

    h.dataOwnerId = 'owner-a';
    h.sessionGeneration += 1;
    const restoredOwnerAAdapter = new DesktopCodexAuthAdapter();
    await expect(
      restoredOwnerAAdapter.getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'instance-isolated',
    });
    await expect(restoredOwnerAAdapter.getAccessToken()).resolves.toBe('isolated-token');
    expect(fs.readFileSync(localAuth)).toEqual(localBeforeSwitch);
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
