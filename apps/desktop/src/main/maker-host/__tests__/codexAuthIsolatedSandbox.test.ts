/**
 * dev 沙箱凭证隔离(XDT_ISOLATED_AUTH=1)回归锁。
 *
 * 背景:codex-home/auth.json 与本机 ~/.codex/auth.json 是共享硬链(「零重复登录」),
 * 隔离沙箱里做 OAuth 登录/登出会改写正式实例与本机 CLI 共用的凭证文件 ——
 * 2026-08-13 Chris 实测:沙箱一登录,本机 OAuth 全部被退登。
 *
 * 期望:restart 脚本提供完整可信 isolated-auth 信号(仅非 packaged)后,reconcile
 *   1) 启动时清空旧 auth，之后显式允许的测试登录可写独立文件且不会被再次清掉;
 *   2) 已存在的共享硬链解除本沙箱一端(unlink 本地链),系统文件原样保留;
 *   3) 开关关闭时行为不变(既有 reconcile 测试覆盖,这里锁默认关)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCodexAuthInvalidationMarkerPath,
  writeInvalidatedSystemCodexAuthMarker,
} from '../codex-auth-invalidation.js';

const dirs: string[] = [];
const h = vi.hoisted(() => ({
  userDataDir: '',
  appDataDir: '',
  dataOwnerId: null as string | null,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'appData' ? h.appDataDir : h.userDataDir),
    getAppPath: () => h.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

vi.mock('../../agent-binaries/index.js', () => ({
  getCachedBinaryStatus: () => ({ binaryReady: false, binaryPath: null }),
  isVettedAgentBinaryPath: () => false,
}));

vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return {
    ...actual,
    getActiveAppSession: () => ({
      mode: h.dataOwnerId ? ('local' as const) : ('signed-out' as const),
      dataOwnerId: h.dataOwnerId,
      generation: 1,
    }),
  };
});

function fixture(): {
  codexHome: string;
  systemAuth: string;
  releaseAuth: string;
  localAuth: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-isolated-auth-'));
  dirs.push(root);
  h.userDataDir = path.join(root, 'user-data');
  h.appDataDir = path.join(root, 'app-data');
  fs.mkdirSync(h.userDataDir, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const systemAuth = path.join(home, '.codex', 'auth.json');
  fs.writeFileSync(
    systemAuth,
    JSON.stringify({
      account: { email: 'dev@example.test' },
      tokens: { access_token: 'system-token', account_id: 'acct-1' },
    }),
  );
  const codexHome = path.join(h.userDataDir, 'codex-home');
  const releaseAuth = path.join(h.appDataDir, 'CindyGlobal', 'codex-home', 'auth.json');
  return {
    codexHome,
    systemAuth,
    releaseAuth,
    localAuth: path.join(codexHome, 'auth.json'),
  };
}

function bindReleaseOpenAi(releaseAuth: string, owner = 'owner-a'): string {
  const bindingPath = path.join(
    path.dirname(path.dirname(releaseAuth)),
    'native-provider-auth.json',
  );
  fs.writeFileSync(bindingPath, JSON.stringify({ openai: owner }));
  return bindingPath;
}

function trustIsolatedAuthSandbox(): void {
  const nonce = 'a'.repeat(64);
  const isolationName = 'test-isolated-auth';
  const now = Date.now();
  fs.writeFileSync(
    path.join(h.userDataDir, '.isolated-auth-launch-proof.json'),
    `${JSON.stringify({
      version: 1,
      nonce,
      userDataDir: fs.realpathSync.native(h.userDataDir),
      profileKind: 'isolated-sandbox',
      epoch: 1,
      isolationName,
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
    })}\n`,
    { mode: 0o600 },
  );
  vi.stubEnv('XDT_ISOLATED', '1');
  vi.stubEnv('XDT_ISOLATED_NAME', isolationName);
  vi.stubEnv('XDT_ISOLATED_AUTH', '1');
  vi.stubEnv('XDT_USER_DATA_DIR_EPOCH', '1');
  vi.stubEnv('XDT_ALLOW_DEV_OAUTH_WRITE', '1');
  vi.stubEnv('XDT_ISOLATED_AUTH_PROOF', nonce);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.dataOwnerId = null;
  h.appDataDir = '';
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('dev 沙箱凭证隔离(XDT_ISOLATED_AUTH)', () => {
  it('开关开:不建共享硬链,本地保持无凭证(登录后走独立文件)', async () => {
    const { localAuth, systemAuth } = fixture();
    trustIsolatedAuthSandbox();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    // getState 内部按需 reconcile;隔离下不得把系统凭证呈现为已登录。
    await expect(adapter.getState()).resolves.toMatchObject({ authenticated: false });
    expect(fs.existsSync(localAuth)).toBe(false);
    // 系统文件原样(内容与链接数都不动)。
    expect(fs.statSync(systemAuth).nlink).toBe(1);
  });

  it('开关开:已存在的共享硬链解除本沙箱一端,系统文件不动', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.linkSync(systemAuth, localAuth);
    expect(fs.statSync(systemAuth).nlink).toBe(2);
    trustIsolatedAuthSandbox();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await adapter.getState();
    expect(fs.existsSync(localAuth)).toBe(false);
    const sysStat = fs.statSync(systemAuth);
    expect(sysStat.nlink).toBe(1);
    expect(JSON.parse(fs.readFileSync(systemAuth, 'utf8')).tokens.access_token).toBe(
      'system-token',
    );
  });

  it.runIf(process.platform !== 'win32')(
    '开关开:系统凭证缺失时清除悬空共享软链,恢复后仍保持隔离',
    async () => {
      const { codexHome, localAuth, systemAuth } = fixture();
      fs.mkdirSync(codexHome, { recursive: true });
      fs.rmSync(systemAuth);
      fs.symlinkSync(systemAuth, localAuth);
      expect(fs.lstatSync(localAuth).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(localAuth)).toBe(false);

      trustIsolatedAuthSandbox();
      h.dataOwnerId = 'owner-a';
      const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
      const adapter = new DesktopCodexAuthAdapter();
      await expect(adapter.getState()).resolves.toMatchObject({ authenticated: false });
      expect(() => fs.lstatSync(localAuth)).toThrow();

      fs.writeFileSync(
        systemAuth,
        JSON.stringify({
          account: { email: 'restored@example.test' },
          tokens: { access_token: 'restored-system-token', account_id: 'acct-restored' },
        }),
      );
      expect(fs.existsSync(localAuth)).toBe(false);
      await expect(adapter.getState()).resolves.toMatchObject({ authenticated: false });
      expect(fs.existsSync(localAuth)).toBe(false);
    },
  );

  it('开关开:旧的独立凭证孤岛也会被清空', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'orphan-token' } }));
    trustIsolatedAuthSandbox();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await adapter.getState();

    expect(fs.existsSync(localAuth)).toBe(false);
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'fresh-test-token' } }));
    const reconcile = (
      adapter as unknown as { reconcileWithSystemCodex(): Promise<void> }
    ).reconcileWithSystemCodex.bind(adapter);
    await reconcile();
    expect(JSON.parse(fs.readFileSync(localAuth, 'utf8')).tokens.access_token).toBe(
      'fresh-test-token',
    );
    expect(JSON.parse(fs.readFileSync(systemAuth, 'utf8')).tokens.access_token).toBe(
      'system-token',
    );
  });

  it('开关关(默认):reconcile 照常建共享硬链', async () => {
    const { localAuth, systemAuth } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    await expect(adapter.getState()).resolves.toMatchObject({ authenticated: true });
    const sysStat = fs.statSync(systemAuth);
    const myStat = fs.statSync(localAuth);
    expect(sysStat.ino).toBe(myStat.ino);
  });

  it('普通隔离 Dev 优先使用同区域 Release 登录态', async () => {
    const { codexHome, localAuth, releaseAuth, systemAuth } = fixture();
    fs.rmSync(systemAuth);
    fs.mkdirSync(path.dirname(releaseAuth), { recursive: true });
    fs.writeFileSync(
      releaseAuth,
      JSON.stringify({
        account: { email: 'release@example.test' },
        tokens: { access_token: 'release-token', account_id: 'acct-release' },
      }),
    );
    const releaseBinding = bindReleaseOpenAi(releaseAuth);
    const releaseBytes = fs.readFileSync(releaseAuth);
    const releaseStat = fs.statSync(releaseAuth);
    const releaseBindingBytes = fs.readFileSync(releaseBinding);
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('release-token');
    await expect(adapter.getAccountId()).resolves.toBe('acct-release');
    await expect(adapter.hasCodexOAuthLogin()).resolves.toBe(true);
    await expect(adapter.getAuthEnv({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      CODEX_HOME: codexHome,
    });
    expect(adapter.hasCodexOAuthLoginReadOnly()).toBe(true);
    expect(readCodexOneShotCreds(adapter)).toEqual({
      accessToken: 'release-token',
      accountId: 'acct-release',
    });
    expect(fs.statSync(localAuth).ino).not.toBe(fs.statSync(releaseAuth).ino);
    // Codex may refresh its local auth.json in place; the Release credential must
    // remain byte-for-byte unchanged because Dev receives a snapshot, not a link.
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'dev-refresh' } }));
    expect(fs.readFileSync(releaseAuth)).toEqual(releaseBytes);
    expect(fs.statSync(releaseAuth).ino).toBe(releaseStat.ino);
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'native-provider-auth.json'), 'utf8')),
    ).toMatchObject({ openai: 'owner-a' });

    await expect(adapter.triggerLogin()).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'dev_oauth_write_blocked',
      oauthWritesBlocked: true,
    });
    await adapter.logout();
    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      oauthWritesBlocked: true,
    });
    expect(fs.readFileSync(releaseAuth)).toEqual(releaseBytes);
    expect(fs.statSync(releaseAuth).ino).toBe(releaseStat.ino);
    expect(fs.readFileSync(releaseBinding)).toEqual(releaseBindingBytes);
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
  });

  it('共享 Dev 直接使用 Release 登录态，不重链接或改 binding', async () => {
    const { releaseAuth, systemAuth } = fixture();
    h.userDataDir = path.join(h.appDataDir, 'CindyGlobal');
    fs.mkdirSync(path.dirname(releaseAuth), { recursive: true });
    fs.writeFileSync(
      releaseAuth,
      JSON.stringify({
        account: { email: 'release@example.test' },
        tokens: { access_token: 'release-token', account_id: 'acct-release' },
      }),
    );
    const releaseBinding = bindReleaseOpenAi(releaseAuth);
    const releaseStat = fs.statSync(releaseAuth);
    const releaseBindingBytes = fs.readFileSync(releaseBinding);
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('release-token');
    expect(fs.statSync(releaseAuth).ino).toBe(releaseStat.ino);
    expect(fs.readFileSync(releaseBinding)).toEqual(releaseBindingBytes);
    expect(fs.readFileSync(systemAuth, 'utf8')).toContain('system-token');
  });

  it('共享 Dev 遇到未绑定的 Release 残留时不覆盖或回落', async () => {
    const { releaseAuth, systemAuth } = fixture();
    h.userDataDir = path.join(h.appDataDir, 'CindyGlobal');
    fs.mkdirSync(path.dirname(releaseAuth), { recursive: true });
    fs.writeFileSync(
      releaseAuth,
      JSON.stringify({
        account: { email: 'unbound-release@example.test' },
        tokens: { access_token: 'unbound-release-token', account_id: 'acct-unbound' },
      }),
    );
    const releaseBytes = fs.readFileSync(releaseAuth);
    const releaseStat = fs.statSync(releaseAuth);
    const releaseBinding = path.join(h.userDataDir, 'native-provider-auth.json');
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBeNull();
    expect(fs.readFileSync(releaseAuth)).toEqual(releaseBytes);
    expect(fs.statSync(releaseAuth).ino).toBe(releaseStat.ino);
    expect(fs.statSync(releaseAuth).ino).not.toBe(fs.statSync(systemAuth).ino);
    expect(fs.existsSync(releaseBinding)).toBe(false);
  });

  it('Release 不属于当前 owner 时不继承，回落本机 Codex', async () => {
    const { localAuth, releaseAuth, systemAuth } = fixture();
    fs.mkdirSync(path.dirname(releaseAuth), { recursive: true });
    fs.writeFileSync(
      releaseAuth,
      JSON.stringify({
        account: { email: 'stale-release@example.test' },
        tokens: { access_token: 'stale-release-token', account_id: 'acct-stale' },
      }),
    );
    bindReleaseOpenAi(releaseAuth, 'owner-other');
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('system-token');
    expect(fs.statSync(localAuth).ino).toBe(fs.statSync(systemAuth).ino);
    expect(fs.statSync(localAuth).ino).not.toBe(fs.statSync(releaseAuth).ino);
  });

  it('Release 登录态已被标记失效时不继承，回落本机 Codex', async () => {
    const { localAuth, releaseAuth, systemAuth } = fixture();
    fs.mkdirSync(path.dirname(releaseAuth), { recursive: true });
    fs.writeFileSync(
      releaseAuth,
      JSON.stringify({
        account: { email: 'invalidated-release@example.test' },
        tokens: { access_token: 'invalidated-release-token', account_id: 'acct-invalidated' },
      }),
    );
    bindReleaseOpenAi(releaseAuth);
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        path.dirname(releaseAuth),
        releaseAuth,
        'token_revoked',
        releaseAuth,
        'system-shared',
        'owner-a',
      ),
    ).toBe(true);
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('system-token');
    expect(fs.statSync(localAuth).ino).toBe(fs.statSync(systemAuth).ino);
    expect(fs.statSync(localAuth).ino).not.toBe(fs.statSync(releaseAuth).ino);
  });

  it('dev 默认只读共享:登录和登出不可改，失效只阻断当前进程', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const onLogout = vi.fn();
    const onInvalidated = vi.fn();
    adapter.setOnLogoutSuccess(onLogout);
    adapter.setOnInvalidatedBroadcast(onInvalidated);

    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      oauthWritesBlocked: true,
    });
    expect(readCodexOneShotCreds(adapter)).toEqual({
      accessToken: 'system-token',
      accountId: 'acct-1',
    });
    const beforeSystem = fs.readFileSync(systemAuth, 'utf8');
    const beforeLocal = fs.readFileSync(localAuth, 'utf8');
    const beforeSystemStat = fs.statSync(systemAuth);
    const beforeLocalStat = fs.statSync(localAuth);

    await expect(adapter.triggerLogin()).resolves.toEqual({
      authenticated: false,
      errorReason: 'dev_oauth_write_blocked',
      oauthWritesBlocked: true,
    });
    await adapter.logout();
    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('system-token');
    await expect(adapter.getAccountId()).resolves.toBe('acct-1');
    await expect(adapter.hasCodexOAuthLogin()).resolves.toBe(true);
    await expect(adapter.getAuthEnv({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      CODEX_HOME: codexHome,
    });
    expect(readCodexOneShotCreds(adapter)).toEqual({
      accessToken: 'system-token',
      accountId: 'acct-1',
    });
    expect(onLogout).not.toHaveBeenCalled();
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(beforeSystem);
    expect(fs.readFileSync(localAuth, 'utf8')).toBe(beforeLocal);
    expect(fs.statSync(systemAuth).ino).toBe(beforeSystemStat.ino);
    expect(fs.statSync(localAuth).ino).toBe(beforeLocalStat.ino);
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);

    const invalidatedAdapter = new DesktopCodexAuthAdapter();
    invalidatedAdapter.setOnInvalidatedBroadcast(onInvalidated);
    await invalidatedAdapter.invalidate('refresh_token_reused');
    expect(onInvalidated).toHaveBeenCalledWith(
      'refresh_token_reused',
      'system-shared',
      true,
    );
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(beforeSystem);
    expect(fs.readFileSync(localAuth, 'utf8')).toBe(beforeLocal);
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
  });

  it('dev 默认只读的 unproven 失效只保留内存边界', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    const onInvalidated = vi.fn();
    adapter.setOnInvalidatedBroadcast(onInvalidated);

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    const systemBytes = fs.readFileSync(systemAuth);
    const localBytes = fs.readFileSync(localAuth);
    const systemStat = fs.statSync(systemAuth);
    const localStat = fs.statSync(localAuth);
    const rm = vi.spyOn(fs.promises, 'rm');
    const chmod = vi.spyOn(fs.promises, 'chmod');

    await adapter.invalidate('child_auth_rejected', { credentialAttribution: 'unproven' });

    expect(onInvalidated).toHaveBeenCalledWith('child_auth_rejected', 'system-shared', true);
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'child_auth_rejected',
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBeNull();
    await expect(adapter.getAccountId()).resolves.toBeNull();
    expect(readCodexOneShotCreds(adapter)).toBeNull();
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBytes);
    expect(fs.readFileSync(localAuth)).toEqual(localBytes);
    expect(fs.statSync(systemAuth)).toMatchObject({ ino: systemStat.ino, mode: systemStat.mode });
    expect(fs.statSync(localAuth)).toMatchObject({ ino: localStat.ino, mode: localStat.mode });
    expect(rm).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();

    await expect(
      new DesktopCodexAuthAdapter().getState({ credentialMode: 'oauth-bearer' }),
    ).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
  });

  it('dev 只读失效以内存指纹等待系统凭证换代,不泄漏旧 token 或写共享文件', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    const invalidatedSystemBytes = fs.readFileSync(systemAuth);
    const invalidatedSystemMode = fs.statSync(systemAuth).mode;

    await adapter.invalidate('refresh_token_reused');

    await expect(adapter.getAccessToken()).resolves.toBeNull();
    await expect(adapter.getAccountId()).resolves.toBeNull();
    expect(readCodexOneShotCreds(adapter)).toBeNull();
    expect(fs.readFileSync(systemAuth)).toEqual(invalidatedSystemBytes);
    expect(fs.readFileSync(localAuth)).toEqual(invalidatedSystemBytes);
    expect(fs.statSync(systemAuth).mode).toBe(invalidatedSystemMode);
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);

    const replacement = path.join(path.dirname(systemAuth), 'auth.replacement.json');
    fs.writeFileSync(
      replacement,
      JSON.stringify({
        account: { email: 'dev@example.test' },
        tokens: { access_token: 'renewed-system-token', account_id: 'acct-1' },
      }),
      { mode: invalidatedSystemMode },
    );
    fs.renameSync(replacement, systemAuth);
    const renewedSystemBytes = fs.readFileSync(systemAuth);
    const renewedSystemMode = fs.statSync(systemAuth).mode;
    expect(readCodexOneShotCreds(adapter)).toBeNull();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      recoveryRequiredReason: 'refresh_token_reused',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('renewed-system-token');
    await expect(adapter.getAccountId()).resolves.toBe('acct-1');
    expect(readCodexOneShotCreds(adapter)).toEqual({
      accessToken: 'renewed-system-token',
      accountId: 'acct-1',
    });
    expect(fs.readFileSync(systemAuth)).toEqual(renewedSystemBytes);
    expect(fs.statSync(systemAuth).mode).toBe(renewedSystemMode);
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);

    const renewedSystemStat = fs.statSync(systemAuth);
    const renewedLocalStat = fs.statSync(localAuth);
    await expect(adapter.verifyRecoveryWithAccountRpc(async () => 'account-ok')).resolves.toBe(
      'account-ok',
    );
    const recoveredState = await adapter.getState({ credentialMode: 'oauth-bearer' });
    expect(recoveredState).toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    expect(recoveredState).not.toHaveProperty('recoveryRequiredReason');
    expect(fs.readFileSync(systemAuth)).toEqual(renewedSystemBytes);
    expect(fs.readFileSync(localAuth)).toEqual(renewedSystemBytes);
    expect(fs.statSync(systemAuth).mode).toBe(renewedSystemMode);
    expect(fs.statSync(systemAuth).ino).toBe(renewedSystemStat.ino);
    expect(fs.statSync(localAuth).ino).toBe(renewedLocalStat.ino);
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
  });

  it('dev 只读系统换代先于迟到失效时记录本地旧代并恢复系统新代', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter, readCodexOneShotCreds } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    const oldGeneration = adapter.captureCredentialGeneration();
    expect(oldGeneration).not.toBeNull();
    const oldLocalBytes = fs.readFileSync(localAuth);
    const originalMode = fs.statSync(systemAuth).mode;

    const replacement = path.join(path.dirname(systemAuth), 'auth.before-late-401.json');
    fs.writeFileSync(
      replacement,
      JSON.stringify({
        account: { email: 'dev@example.test' },
        tokens: { access_token: 'preexisting-renewed-token', account_id: 'acct-1' },
      }),
      { mode: originalMode },
    );
    fs.renameSync(replacement, systemAuth);
    const renewedSystemBytes = fs.readFileSync(systemAuth);
    const renewedSystemStat = fs.statSync(systemAuth);
    if (process.platform === 'win32') {
      expect(fs.readFileSync(localAuth)).toEqual(oldLocalBytes);
      expect(fs.readFileSync(localAuth)).not.toEqual(renewedSystemBytes);
    } else {
      expect(fs.readFileSync(localAuth)).toEqual(renewedSystemBytes);
    }

    const chmod = vi.spyOn(fs.promises, 'chmod');
    await adapter.invalidate('late_host_401', { credentialGeneration: oldGeneration });

    expect(readCodexOneShotCreds(adapter)).toBeNull();
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      recoveryRequiredReason: 'late_host_401',
      oauthWritesBlocked: true,
    });
    await expect(adapter.getAccessToken()).resolves.toBe('preexisting-renewed-token');
    await adapter.verifyRecoveryWithAccountRpc(async () => undefined);
    const recoveredState = await adapter.getState({ credentialMode: 'oauth-bearer' });
    expect(recoveredState).toMatchObject({
      authenticated: true,
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    });
    expect(recoveredState).not.toHaveProperty('recoveryRequiredReason');
    expect(fs.readFileSync(systemAuth)).toEqual(renewedSystemBytes);
    expect(fs.readFileSync(localAuth)).toEqual(renewedSystemBytes);
    expect(fs.statSync(systemAuth).mode).toBe(renewedSystemStat.mode);
    expect(fs.statSync(systemAuth).ino).toBe(renewedSystemStat.ino);
    expect(chmod).not.toHaveBeenCalled();
    expect(fs.existsSync(getCodexAuthInvalidationMarkerPath(codexHome))).toBe(false);
  });

  it('普通 isolated 的写开关不能绕过只读门禁或改写共享凭证', async () => {
    const { localAuth, systemAuth } = fixture();
    const systemBytes = fs.readFileSync(systemAuth);
    const systemStat = fs.statSync(systemAuth);
    vi.stubEnv('XDT_ISOLATED', '1');
    vi.stubEnv('XDT_ALLOW_DEV_OAUTH_WRITE', '1');
    h.dataOwnerId = 'owner-a';
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      oauthWritesBlocked: true,
    });
    expect(fs.readFileSync(localAuth)).toEqual(systemBytes);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBytes);
    expect(fs.statSync(systemAuth).mode).toBe(systemStat.mode);
    expect(fs.statSync(systemAuth).ino).toBe(systemStat.ino);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('ambient 四变量与任意 userData 不能伪造 proof 或改写凭证', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      localAuth,
      JSON.stringify({ tokens: { access_token: 'instance-token', account_id: 'acct-local' } }),
      { mode: 0o600 },
    );
    const localBytes = fs.readFileSync(localAuth);
    const localStat = fs.statSync(localAuth);
    const systemBytes = fs.readFileSync(systemAuth);
    const systemStat = fs.statSync(systemAuth);
    vi.stubEnv('XDT_USER_DATA_DIR', h.userDataDir);
    vi.stubEnv('XDT_ISOLATED', '1');
    vi.stubEnv('XDT_ISOLATED_AUTH', '1');
    vi.stubEnv('XDT_USER_DATA_DIR_EPOCH', '1');
    vi.stubEnv('XDT_ALLOW_DEV_OAUTH_WRITE', '1');
    h.dataOwnerId = 'owner-a';
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      oauthWritesBlocked: true,
    });
    await expect(adapter.triggerLogin()).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'dev_oauth_write_blocked',
      oauthWritesBlocked: true,
    });
    expect(fs.readFileSync(localAuth)).toEqual(localBytes);
    expect(fs.statSync(localAuth).ino).toBe(localStat.ino);
    expect(fs.statSync(localAuth).mode).toBe(localStat.mode);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBytes);
    expect(fs.statSync(systemAuth).ino).toBe(systemStat.ino);
    expect(fs.statSync(systemAuth).mode).toBe(systemStat.mode);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('受信 isolated-auth 沙箱可从空凭证启动并解除写门禁', async () => {
    const { localAuth, systemAuth } = fixture();
    const systemBytes = fs.readFileSync(systemAuth);
    const systemStat = fs.statSync(systemAuth);
    trustIsolatedAuthSandbox();
    h.dataOwnerId = 'owner-a';
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');

    const state = await new DesktopCodexAuthAdapter().getState();
    expect(state).toMatchObject({ authenticated: false });
    expect(state).not.toHaveProperty('oauthWritesBlocked');
    expect(fs.existsSync(localAuth)).toBe(false);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBytes);
    expect(fs.statSync(systemAuth).ino).toBe(systemStat.ino);
    expect(fs.statSync(systemAuth).mode).toBe(systemStat.mode);
    expect(chmod).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(h.userDataDir, '.isolated-auth-launch-proof.json')),
    ).toBe(false);
  });

  it('排队登录在 logout barrier 后执行自己的 isolated-auth 清理', async () => {
    const { codexHome, localAuth, systemAuth } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'stale-sandbox-token' } }));
    const systemBytes = fs.readFileSync(systemAuth);
    trustIsolatedAuthSandbox();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();
    let finishLogout!: () => void;
    const logoutOperation = new Promise<void>((resolve) => {
      finishLogout = resolve;
    });
    const privateState = adapter as unknown as {
      logoutOperation: Promise<void> | null;
      isolatedAuthSanitized: boolean;
      pendingLogin: unknown;
    };
    privateState.logoutOperation = logoutOperation;

    const login = adapter.triggerLogin({ mode: 'device-code' });
    await Promise.resolve();
    expect(fs.existsSync(localAuth)).toBe(true);
    expect(privateState.isolatedAuthSanitized).toBe(false);

    privateState.logoutOperation = null;
    finishLogout();
    await expect(login).resolves.toMatchObject({
      authenticated: false,
      errorReason: 'codex_binary_missing',
    });

    expect(fs.existsSync(localAuth)).toBe(false);
    expect(privateState.isolatedAuthSanitized).toBe(true);
    expect(privateState.pendingLogin).toBeNull();
    expect(fs.readFileSync(systemAuth)).toEqual(systemBytes);
  });

  it('proof 绑定其它 userData 时保持只读且不消费凭证', async () => {
    const { localAuth, systemAuth } = fixture();
    fs.mkdirSync(path.dirname(localAuth), { recursive: true });
    fs.writeFileSync(localAuth, JSON.stringify({ tokens: { access_token: 'instance-token' } }));
    const localBytes = fs.readFileSync(localAuth);
    const systemBytes = fs.readFileSync(systemAuth);
    trustIsolatedAuthSandbox();
    const proofPath = path.join(h.userDataDir, '.isolated-auth-launch-proof.json');
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    proof.userDataDir = path.join(path.dirname(h.userDataDir), 'another-profile');
    fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
    h.dataOwnerId = 'owner-a';
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');

    await expect(new DesktopCodexAuthAdapter().getState()).resolves.toMatchObject({
      oauthWritesBlocked: true,
    });
    expect(fs.readFileSync(localAuth)).toEqual(localBytes);
    expect(fs.readFileSync(systemAuth)).toEqual(systemBytes);
    expect(chmod).not.toHaveBeenCalled();
  });
});
