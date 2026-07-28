/**
 * analyticsSettingsService.test.ts —— 存量同意迁移的触发边界。
 *
 * 这个边界是本次改动最容易被改坏的地方,两条都不能放宽:
 *  1. 迁移只能认**冷启动恢复出来的**登录态。放宽成「任何时候看到登录就算同意」,
 *     新的企业 SSO 登录会被误判为已同意——登录页的协议门恰恰豁免了 SSO 入口。
 *  2. 只有**真实账号**算已登录。本地模式(跳过登录)同样免协议门,把它算成已登录
 *     等于给从未同意隐私协议的用户静默打开采集。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/analytics-service-test' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../lifecycle', () => ({ onQuit: vi.fn() }));
vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

const isLocalMode = vi.fn(() => false);
vi.mock('../authManager', () => ({
  isLocalMode: () => isLocalMode(),
  getAuthState: () => ({ isAuthenticated: false }),
  onAuthStateChange: () => () => {},
}));

/**
 * 盘上那份 analytics-settings.json 的内存替身。
 *
 * 迁移替身会真的往里写 privacyConsentAccepted,这样「有没有被静默开启采集」可以按
 * 落盘结果断言,而不是只看函数被调了几次——隐私红线要看结果。
 */
const fakeSettings = { privacyConsentAccepted: false, analyticsEnabled: true };
function migrateIntoFakeSettings(signedIn: boolean): boolean {
  if (!signedIn) return false;
  if (fakeSettings.privacyConsentAccepted) return false;
  fakeSettings.privacyConsentAccepted = true;
  return true;
}
const migrateExistingLoginAsConsented = vi.fn(migrateIntoFakeSettings);
vi.mock('../analytics-settings-store', () => ({
  migrateExistingLoginAsConsented: (signedIn: boolean) => migrateExistingLoginAsConsented(signedIn),
  acceptPrivacyConsent: vi.fn(),
  setAnalyticsEnabled: vi.fn(),
  isAnalyticsAllowed: () => false,
  readAnalyticsSettings: () => ({ ...fakeSettings }),
}));

async function importService() {
  vi.resetModules();
  return import('../analyticsSettingsService');
}

beforeEach(() => {
  isLocalMode.mockReturnValue(false);
  fakeSettings.privacyConsentAccepted = false;
  fakeSettings.analyticsEnabled = true;
  migrateExistingLoginAsConsented.mockClear();
  migrateExistingLoginAsConsented.mockImplementation(migrateIntoFakeSettings);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cold-start consent migration', () => {
  it('migrates when the cold start restored a signed-in session', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
    expect(fakeSettings.privacyConsentAccepted).toBe(true);
  });

  // 「跳过登录」= 不创建账号、不上报数据(2026-07-27 拍板),刻意免协议门。把它当成
  // 已登录会在下一次冷启动静默写入 privacyConsentAccepted,等于未经同意开启采集。
  it('never migrates a restored local-mode (skip-login) session', async () => {
    isLocalMode.mockReturnValue(true);
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, null);

    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
  });

  it('never migrates when the pending cold start settles into local mode', async () => {
    isLocalMode.mockReturnValue(true);
    const service = await importService();

    const pending = Promise.resolve({ isAuthenticated: false });
    service.noteAuthColdStartState({ isAuthenticated: false }, pending);
    await pending;
    await Promise.resolve();

    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
  });

  // 本地模式不迁移 ≠ 永久拉黑本机:用户之后真的登录账号,下一次冷启动照常迁移。
  it('still migrates on a later cold start after the user really signs in', async () => {
    isLocalMode.mockReturnValue(true);
    const localOnly = await importService();
    localOnly.noteAuthColdStartState({ isAuthenticated: false }, null);
    expect(fakeSettings.privacyConsentAccepted).toBe(false);

    // 新进程:模块级 guard 重置,这次冷启动恢复出的是真实账号。
    isLocalMode.mockReturnValue(false);
    const signedIn = await importService();
    signedIn.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
    expect(fakeSettings.privacyConsentAccepted).toBe(true);
  });

  it('does not migrate a signed-out cold start', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, null);

    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
  });

  it('ignores logins that happen after the cold-start verdict (e.g. enterprise SSO)', async () => {
    const service = await importService();

    // 冷启动未登录 → 定论「新用户」
    service.noteAuthColdStartState({ isAuthenticated: false }, null);
    // 之后用户走 SSO 登录成功(SSO 被协议门豁免,从没点过同意)
    service.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
  });

  it('evaluates only once even when several windows each call auth:initialize', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    service.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('waits for the pending cold-start result instead of ruling too early', async () => {
    const service = await importService();

    // 慢网:renderer 先拿到未登录兜底态,真结果还在路上。急着定论会把存量用户
    // 当成新用户,凭空少掉统计。
    let resolvePending: (state: { isAuthenticated: boolean }) => void = () => {};
    const pending = new Promise<{ isAuthenticated: boolean }>((resolve) => {
      resolvePending = resolve;
    });

    service.noteAuthColdStartState({ isAuthenticated: false }, pending);
    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();

    resolvePending({ isAuthenticated: true });
    await pending;
    await Promise.resolve();

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing migration break authentication', async () => {
    // 调用点在 auth:initialize 的 try 块里。userData 只读或写满时 writePatch 会同步
    // 抛出,若不吞掉,一次本来成功的认证会被判失败,renderer 直接把用户归一成未登录。
    // 埋点写不进去就算了,登录不能断。
    migrateExistingLoginAsConsented.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    const service = await importService();

    expect(() => service.noteAuthColdStartState({ isAuthenticated: true }, null)).not.toThrow();
    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('closes the migration window when the pending cold start rejects', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, Promise.reject(new Error('boom')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
  });
});
