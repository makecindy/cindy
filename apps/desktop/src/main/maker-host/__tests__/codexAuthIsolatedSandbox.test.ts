/**
 * dev 沙箱凭证隔离(XDT_ISOLATED_AUTH=1)回归锁。
 *
 * 背景:codex-home/auth.json 与本机 ~/.codex/auth.json 是共享硬链(「零重复登录」),
 * 隔离沙箱里做 OAuth 登录/登出会改写正式实例与本机 CLI 共用的凭证文件 ——
 * 2026-08-13 Chris 实测:沙箱一登录,本机 OAuth 全部被退登。
 *
 * 期望:置 XDT_ISOLATED_AUTH=1(仅非 packaged)后,reconcile
 *   1) 不再新建共享硬链(本地无 auth.json 时保持无,登录后写独立文件);
 *   2) 已存在的共享硬链解除本沙箱一端(unlink 本地链),系统文件原样保留;
 *   3) 开关关闭时行为不变(既有 reconcile 测试覆盖,这里锁默认关)。
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

function fixture(): { codexHome: string; systemAuth: string; localAuth: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-isolated-auth-'));
  dirs.push(root);
  h.userDataDir = path.join(root, 'user-data');
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
  return { codexHome, systemAuth, localAuth: path.join(codexHome, 'auth.json') };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.dataOwnerId = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('dev 沙箱凭证隔离(XDT_ISOLATED_AUTH)', () => {
  it('开关开:不建共享硬链,本地保持无凭证(登录后走独立文件)', async () => {
    const { localAuth, systemAuth } = fixture();
    vi.stubEnv('XDT_ISOLATED_AUTH', '1');
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
    vi.stubEnv('XDT_ISOLATED_AUTH', '1');
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
});
