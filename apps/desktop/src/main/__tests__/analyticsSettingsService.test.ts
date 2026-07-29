/**
 * analyticsSettingsService.test.ts —— 存量同意迁移的触发边界。
 *
 * 这个边界是本次改动最容易被改坏的地方,三条都不能放宽:
 *  1. 迁移只能认**冷启动恢复出来的**登录态。放宽成「任何时候看到登录就算同意」,
 *     新的企业 SSO 登录会被误判为已同意——登录页的协议门恰恰豁免了 SSO 入口。
 *  2. 只有**真实账号**算已登录。本地模式(跳过登录)同样免协议门,把它算成已登录
 *     等于给从未同意隐私协议的用户静默打开采集。
 *  3. 「无存量登录态」的冷启动结论必须**落盘**(2026-07-28 review P1):否则
 *     「跳过登录 → 从本地模式走登录入口 → 完成 SSO」之后的下一次冷启动会看到
 *     「真实账号 + 零记录」,与真存量账号无法区分,被静默迁移。异常/未决不落盘。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 广播到 renderer 的 payload 序列 —— 本地模式的 opt-out 必须真的被重播出去。 */
const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/analytics-service-test' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, payload: Record<string, unknown>) => {
            broadcasts.push(payload);
          },
        },
      },
    ],
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../lifecycle', () => ({ onQuit: vi.fn() }));
vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

const isLocalMode = vi.fn(() => false);
/**
 * 「本机确定没有持久登录凭证」。默认 true(= 干净新装/已清凭证),需要模拟
 * 「有账号但本次冷启动瞬态失败仍保留 token」的机器时置 false。
 */
const hasNoPersistedAuthCredentials = vi.fn(() => true);
let authStateListener: (() => void) | null = null;
vi.mock('../authManager', () => ({
  isLocalMode: () => isLocalMode(),
  hasNoPersistedAuthCredentials: () => hasNoPersistedAuthCredentials(),
  getAuthState: () => ({ isAuthenticated: false }),
  onAuthStateChange: (listener: () => void) => {
    authStateListener = listener;
    return () => {
      authStateListener = null;
    };
  },
}));

/**
 * 盘上那份 analytics-settings.json 的内存替身。
 *
 * 迁移替身会真的往里写 privacyConsentAccepted,这样「有没有被静默开启采集」可以按
 * 落盘结果断言,而不是只看函数被调了几次——隐私红线要看结果。
 * legacyConsentMigrationClosed 同理:它是**持久**标记,替身跨 importService(= 跨
 * 「重启」)存活,skip → SSO 链路的回归必须按「下次冷启动还认不认」断言。
 */
const fakeSettings = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  legacyConsentMigrationClosed: false,
};
function migrateIntoFakeSettings(signedIn: boolean): boolean {
  if (!signedIn) return false;
  if (fakeSettings.privacyConsentAccepted) return false;
  if (fakeSettings.legacyConsentMigrationClosed) return false;
  fakeSettings.privacyConsentAccepted = true;
  return true;
}
const migrateExistingLoginAsConsented = vi.fn(migrateIntoFakeSettings);
function closeIntoFakeSettings(): boolean {
  if (fakeSettings.legacyConsentMigrationClosed) return false;
  fakeSettings.legacyConsentMigrationClosed = true;
  return true;
}
const closeLegacyConsentMigration = vi.fn(closeIntoFakeSettings);
vi.mock('../analytics-settings-store', () => ({
  migrateExistingLoginAsConsented: (signedIn: boolean) => migrateExistingLoginAsConsented(signedIn),
  closeLegacyConsentMigration: () => closeLegacyConsentMigration(),
  acceptPrivacyConsent: vi.fn(),
  setAnalyticsEnabled: vi.fn(),
  clearAnalyticsEnabledOverride: vi.fn(),
  // store 侧的真实语义(构建闸在真实实现里另算,这里按已同意 && 开关开启放行),
  // 这样「本地模式闸」是否生效可以被独立断言。
  isAnalyticsAllowed: () => fakeSettings.privacyConsentAccepted && fakeSettings.analyticsEnabled,
  isAnalyticsEnabledCustomized: () => false,
  readAnalyticsSettings: () => ({ ...fakeSettings }),
}));

async function importService() {
  vi.resetModules();
  return import('../analyticsSettingsService');
}

beforeEach(() => {
  isLocalMode.mockReturnValue(false);
  hasNoPersistedAuthCredentials.mockReturnValue(true);
  authStateListener = null;
  fakeSettings.privacyConsentAccepted = false;
  fakeSettings.analyticsEnabled = true;
  fakeSettings.legacyConsentMigrationClosed = false;
  migrateExistingLoginAsConsented.mockClear();
  // mockClear 只清调用记录、**不还原 implementation**:用例里注入的 throw 替身若不在
  // 这里恢复,会泄漏到后续用例,把「不该关窗 / 不该迁移」的断言变成假绿(异常被吞掉,
  // 看着像没执行)。两个替身都必须显式复位。
  migrateExistingLoginAsConsented.mockImplementation(migrateIntoFakeSettings);
  closeLegacyConsentMigration.mockClear();
  closeLegacyConsentMigration.mockImplementation(closeIntoFakeSettings);
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

  // 2026-07-28 review P1:本地模式冷启动 = 本机确定不是「改版前存量账号」,这个结论
  // **落盘**、永久有效。用户之后从本地模式走登录入口完成企业 SSO(免协议门、零同意
  // 记录),下一次冷启动恢复出「真实账号 + 零记录」——与真存量账号长得一模一样,若
  // 窗口没关死就会被静默迁移成已同意。个人账号登录不受影响:协议门放行那刻已写入
  // 真同意(acceptPrivacyConsent),根本轮不到迁移。
  it('never migrates on a later cold start once a skip-login cold start closed the window (skip → SSO)', async () => {
    isLocalMode.mockReturnValue(true);
    const localOnly = await importService();
    localOnly.noteAuthColdStartState({ isAuthenticated: false }, null);
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
    expect(fakeSettings.legacyConsentMigrationClosed).toBe(true);

    // 新进程:模块级 guard 重置,这次冷启动恢复出的是(经免协议 SSO 建立的)真实账号。
    isLocalMode.mockReturnValue(false);
    const signedIn = await importService();
    signedIn.noteAuthColdStartState({ isAuthenticated: true }, null);

    // migrate 可以被调(第三道闸在 store 内),但绝不允许写入同意。
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
  });

  it('also closes the window persistently on a plain signed-out cold start (pure-SSO new install)', async () => {
    const first = await importService();
    first.noteAuthColdStartState({ isAuthenticated: false }, null);
    expect(fakeSettings.legacyConsentMigrationClosed).toBe(true);

    // 纯 SSO 新装:之后 SSO 登录成功,下次冷启动恢复出真实账号,同样不得迁移。
    const restarted = await importService();
    restarted.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
  });

  it('closes the window when the pending cold start settles into signed-out', async () => {
    const service = await importService();

    const pending = Promise.resolve({ isAuthenticated: false });
    service.noteAuthColdStartState({ isAuthenticated: false }, pending);
    await pending;
    await Promise.resolve();

    expect(fakeSettings.legacyConsentMigrationClosed).toBe(true);
  });

  it('does NOT persist the closure when the pending cold start rejects — verdict unclear', async () => {
    // 弱网存量用户:refresh 异常 ≠「确定没有存量登录态」。落盘会把真存量用户永久误判。
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, Promise.reject(new Error('boom')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeSettings.legacyConsentMigrationClosed).toBe(false);

    // 下一次冷启动(新进程)恢复出真实账号:窗口仍开,存量用户照常迁移。
    const restarted = await importService();
    restarted.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(fakeSettings.privacyConsentAccepted).toBe(true);
  });

  it('never lets a failing window-closure break authentication', async () => {
    closeLegacyConsentMigration.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    isLocalMode.mockReturnValue(true);
    const service = await importService();

    expect(() => service.noteAuthColdStartState({ isAuthenticated: false }, null)).not.toThrow();
  });

  // 2026-07-28 review 追加(P2):`initialize()` 在对端区域清单不可用 / cold-start
  // refresh 瞬态失败时会**保留 refresh token** 并以未登录放行 UI(pendingCompletion
  // === null)。那种机器下一次冷启动就是真实的存量账号,绝不能因为这一次的「未登录」
  // 被永久关窗 —— 否则存量用户永远拿不到本该有的同意迁移。
  it('keeps the window open when a signed-out cold start still holds persisted credentials', async () => {
    hasNoPersistedAuthCredentials.mockReturnValue(false);
    const transient = await importService();

    transient.noteAuthColdStartState({ isAuthenticated: false }, null);

    expect(closeLegacyConsentMigration).not.toHaveBeenCalled();
    expect(fakeSettings.legacyConsentMigrationClosed).toBe(false);

    // 下一次冷启动 refresh 成功,恢复出真实的存量账号:迁移照常发生。
    const recovered = await importService();
    recovered.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(fakeSettings.privacyConsentAccepted).toBe(true);
  });

  it('keeps the window open when the pending cold start settles signed-out with credentials intact', async () => {
    hasNoPersistedAuthCredentials.mockReturnValue(false);
    const service = await importService();

    const pending = Promise.resolve({ isAuthenticated: false });
    service.noteAuthColdStartState({ isAuthenticated: false }, pending);
    await pending;
    await Promise.resolve();

    expect(fakeSettings.legacyConsentMigrationClosed).toBe(false);
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

  it('still seals the in-process verdict when the pending cold start rejects', async () => {
    // 异常只关**本进程**的窗(migrationEvaluated),不落盘 —— 持久语义见上面的
    // "does NOT persist the closure" 用例。同进程内稍后的登录(如 SSO)不得迁移。
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, Promise.reject(new Error('boom')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
  });
});

/**
 * 本地模式(跳过登录)期间的上报闸 —— 2026-07-28 review P1。
 *
 * 同意事实是本机级的:此前登录过(或被存量迁移过)的用户盘上已有
 * privacyConsentAccepted: true。他点「跳过登录」进入本地模式后,若 allowed 仍为真,
 * TapDB 会继续发设备级事件(authManager 只清 accountId,不 opt-out),违反
 * 2026-07-27「跳过登录 = 不上报数据」的拍板。闸是运行时的:不写盘、不改用户真相。
 */
describe('local-mode reporting gate', () => {
  it('refuses to report while in local mode even when consent is on disk', async () => {
    fakeSettings.privacyConsentAccepted = true;
    fakeSettings.analyticsEnabled = true;
    const service = await importService();

    expect(service.analyticsSettingsPayload().allowed).toBe(true);

    isLocalMode.mockReturnValue(true);
    const inLocalMode = service.analyticsSettingsPayload();
    expect(inLocalMode.allowed).toBe(false);
    // 闸不得篡改用户的持久真相(退出本地模式后要原样恢复)。
    expect(inLocalMode.privacyConsentAccepted).toBe(true);
    expect(inLocalMode.analyticsEnabled).toBe(true);
    expect(fakeSettings.privacyConsentAccepted).toBe(true);
    expect(fakeSettings.analyticsEnabled).toBe(true);
  });

  it('lets reporting resume once local mode is left', async () => {
    fakeSettings.privacyConsentAccepted = true;
    isLocalMode.mockReturnValue(true);
    const service = await importService();
    expect(service.analyticsSettingsPayload().allowed).toBe(false);

    isLocalMode.mockReturnValue(false);
    expect(service.analyticsSettingsPayload().allowed).toBe(true);
  });

  // gate 只有一半:renderer 的 TapDB 已 init 时不会自己 opt-out,必须收到重播。
  it('rebroadcasts the verdict on auth state change so an initialized SDK opts out', async () => {
    fakeSettings.privacyConsentAccepted = true;
    const service = await importService();
    service.initAnalyticsSettingsService();
    broadcasts.length = 0;

    isLocalMode.mockReturnValue(true);
    authStateListener?.();

    expect(broadcasts.at(-1)).toMatchObject({ allowed: false, privacyConsentAccepted: true });
  });

  it('unsubscribes from auth state on quit teardown', async () => {
    const service = await importService();
    service.initAnalyticsSettingsService();
    expect(authStateListener).not.toBeNull();

    service.__testing.resetForTests();
    expect(authStateListener).toBeNull();
  });

  // 2026-07-28 review 追加:用户主动点「跳过登录」是无歧义事件,封窗不得依赖凭证探测。
  // 密钥链恰好不可用时探测会返回「可能还有凭证」,若那时不封窗,之后的免协议 SSO 就会
  // 被静默迁移成已同意 —— 正是本轮要堵的洞。
  it('seals the migration window on entering local mode even when the credential probe is inconclusive', async () => {
    hasNoPersistedAuthCredentials.mockReturnValue(false);
    const service = await importService();
    service.initAnalyticsSettingsService();

    isLocalMode.mockReturnValue(true);
    authStateListener?.();

    expect(fakeSettings.legacyConsentMigrationClosed).toBe(true);

    // 之后从本地模式走免协议 SSO,下一次冷启动恢复出真实账号:不得写入同意。
    isLocalMode.mockReturnValue(false);
    const restarted = await importService();
    restarted.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(fakeSettings.privacyConsentAccepted).toBe(false);
  });

  it('does not seal the window on ordinary sign-in state changes', async () => {
    const service = await importService();
    service.initAnalyticsSettingsService();

    isLocalMode.mockReturnValue(false);
    authStateListener?.();

    expect(closeLegacyConsentMigration).not.toHaveBeenCalled();
    expect(fakeSettings.legacyConsentMigrationClosed).toBe(false);
  });

  it('never lets a failing seal break the auth state change path', async () => {
    closeLegacyConsentMigration.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    const service = await importService();
    service.initAnalyticsSettingsService();

    isLocalMode.mockReturnValue(true);
    expect(() => authStateListener?.()).not.toThrow();
  });
});
