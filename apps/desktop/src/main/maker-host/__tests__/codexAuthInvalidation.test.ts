import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_USER_DISCONNECT_REASON,
  getActiveInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  shouldSuppressLocalCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
} from '../codex-auth-invalidation.js';

const dirs: string[] = [];
const h = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userDataDir,
    getAppPath: () => h.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

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

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex system credential suppression marker', () => {
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
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        'token_invalidated',
        localAuth,
      ),
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
    fs.writeFileSync(localAuth, JSON.stringify({
      tokens: {
        access_token: 'local-token',
        id_token: idToken({ sub: 'user-subject' }),
      },
    }));
    await expect(adapter.getAccountId()).resolves.toBeNull();

    fs.writeFileSync(localAuth, JSON.stringify({
      tokens: {
        access_token: 'local-token',
        id_token: idToken({
          sub: 'user-subject',
          'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-actual' },
        }),
      },
    }));
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
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('EPERM: file is locked'));

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
    const codexHome = path.join(h.userDataDir, 'codex-home');
    const localAuth = path.join(codexHome, 'auth.json');
    const cachePath = path.join(codexHome, 'models_cache.json');
    fs.mkdirSync(codexHome, { recursive: true });
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
    await vi.waitFor(() => expect(finalizer).toHaveBeenCalledWith('token_invalidated'));
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

  it('real token invalidation still surfaces its reason when no replacement local credential exists', () => {
    const { codexHome, systemAuth, localAuth } = fixture();
    writeInvalidatedSystemCodexAuthMarker(codexHome, systemAuth, 'token_invalidated', localAuth);

    expect(restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth)).toEqual({
      suppressReconcile: true,
      invalidatedReason: 'token_invalidated',
    });
  });
});
