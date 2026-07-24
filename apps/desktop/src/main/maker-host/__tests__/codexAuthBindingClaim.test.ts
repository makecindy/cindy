/**
 * Codex OAuth 绑定自愈(claimDetectedCodexOAuthBinding)+ readState 绑定 gate 集成测试。
 *
 * 背景 bug:一次性 legacy 迁移(migrateLegacyNativeProviderAuthBindings)在 reconcile
 * 硬链建立之前快照 hasCodexOAuthLoginUnbound(),openai 名额以 false 被永久消费;local
 * 模式 owner 则从不跑该迁移。结果 getState 报 authenticated(直读 auth.json)而
 * provider connected=false(查绑定)—— 设置页「已连接」与聊天门禁「无来源」自相矛盾。
 *
 * 修复后的期望:reconcile 收口为首个 owner 补绑定,getState / getAccessToken /
 * provider connected 三者同口径;换账号(绑定归属他人)保持 fail-closed,且 getState
 * 不再以 OAuth 已连接示人。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];
const h = vi.hoisted(() => ({ userDataDir: '', dataOwnerId: null as string | null }));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userDataDir,
    getAppPath: () => h.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

// 只覆写 getActiveAppSession(绑定判定的唯一输入);其余导出保持原实现,供
// appCapabilities / providerSecretStore 等传递依赖正常加载。mode 用 'local':
// 绑定逻辑只看 dataOwnerId,而 local 模式关闭网关能力,readState 的网关 key
// fallback 分支确定性返回未认证,不触碰任何真实凭证存储。
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

function fixture(): { codexHome: string; systemAuth: string; localAuth: string; bindingFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-binding-claim-'));
  dirs.push(root);
  h.userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(h.userDataDir, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const systemAuth = path.join(home, '.codex', 'auth.json');
  // reconcile 的账号识别需要 account_id;access_token 是 OAuth 判定与绑定 claim 的凭证。
  fs.writeFileSync(
    systemAuth,
    JSON.stringify({
      account: { email: 'dev@example.test' },
      tokens: { access_token: 'system-token', account_id: 'acct-1' },
    }),
  );
  const codexHome = path.join(h.userDataDir, 'codex-home');
  return {
    codexHome,
    systemAuth,
    localAuth: path.join(codexHome, 'auth.json'),
    bindingFile: path.join(h.userDataDir, 'native-provider-auth.json'),
  };
}

function readBindingFile(bindingFile: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(bindingFile, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  h.dataOwnerId = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('codex OAuth binding auto-claim on reconcile', () => {
  it('binds the detected system CLI credential to the current owner within one getState call', async () => {
    const { bindingFile } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
      identity: 'dev@example.test',
    });
    expect(readBindingFile(bindingFile)).toMatchObject({ openai: 'owner-a' });
    await expect(adapter.getAccessToken()).resolves.toBe('system-token');
  });

  it('repairs a claim that the one-shot migration consumed before the reconcile hardlink existed', async () => {
    const { bindingFile } = fixture();
    // 竞态残局:legacyClaimOwner 已写下,openai 名额被 false 消费。
    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: 'owner-a' }));
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(readBindingFile(bindingFile)).toMatchObject({
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('keeps another owner fail-closed and stops reporting the unbound OAuth as connected', async () => {
    const { bindingFile } = fixture();
    fs.writeFileSync(
      bindingFile,
      JSON.stringify({ openai: 'owner-a', legacyClaimOwner: 'owner-a' }),
    );
    h.dataOwnerId = 'owner-b';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toEqual({
      authenticated: false,
      errorReason: 'oauth_not_bound',
    });
    await expect(adapter.getAccessToken()).resolves.toBeNull();
    // 归属绝不被改写。
    expect(readBindingFile(bindingFile)).toMatchObject({ openai: 'owner-a' });
  });

  it('does not claim while a durable user disconnect suppresses the local credential', async () => {
    const { codexHome, systemAuth, localAuth, bindingFile } = fixture();
    fs.mkdirSync(codexHome, { recursive: true });
    fs.copyFileSync(systemAuth, localAuth);
    const { CODEX_USER_DISCONNECT_REASON, writeInvalidatedSystemCodexAuthMarker } = await import(
      '../codex-auth-invalidation.js'
    );
    expect(
      writeInvalidatedSystemCodexAuthMarker(
        codexHome,
        systemAuth,
        CODEX_USER_DISCONNECT_REASON,
        localAuth,
      ),
    ).toBe(true);
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toMatchObject({ authenticated: false });
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('drops the claim when the app session switches owners during an in-flight reconcile', async () => {
    // review P1:claim 只允许写给「reconcile 发起时」的会话;在途期间切换账号必须放弃,
    // 绝不把 A 时代发起的认领写到 B 名下。B 自己的下一次 reconcile 会按 B 的规则重试。
    const { bindingFile } = fixture();
    h.dataOwnerId = 'owner-a';
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    // getState 的同步段捕获 sessionAtStart(owner-a);首个 await 挂起后切到 owner-b。
    const statePromise = adapter.getState();
    h.dataOwnerId = 'owner-b';
    await expect(statePromise).resolves.toEqual({
      authenticated: false,
      errorReason: 'oauth_not_bound',
    });
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('keeps pre-session behavior without writing any binding when no owner is committed', async () => {
    const { bindingFile } = fixture();
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = new DesktopCodexAuthAdapter();

    await expect(adapter.getState()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(fs.existsSync(bindingFile)).toBe(false);
  });
});
