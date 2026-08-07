/**
 * analyticsSettingsStore.test.ts —— 使用统计(TapDB)同意闸的持久化行为。
 *
 * 这里测的是合规行为本身,不是配置读写的花样:
 *  - 默认必须是「未同意」,即 allowed=false(fail closed)
 *  - 同意后才允许上报,且开关能独立关掉
 *  - 存量迁移只在本机毫无记录时生效,绝不覆盖用户已有选择
 *  - dev 构建一律不上报(构建闸),且不因此篡改用户的同意与开关
 *
 * 用真实 tmpdir 当 userData(mkdtemp),覆盖到落盘与回读,而不是只测 normalize。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
/** 除「构建闸」那一组之外,所有用例测的都是正式构建下的同意语义。 */
let isPackaged = true;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : userDataDir),
    // getter:构建 flavor 要能在用例内切换,不能在 mock 工厂调用那一刻定死。
    get isPackaged() {
      return isPackaged;
    },
  },
}));
vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

async function importStore() {
  vi.resetModules();
  return import('../analytics-settings-store');
}

function settingsFile(): string {
  return path.join(userDataDir, 'analytics-settings.json');
}

const originalDevReportingEnv = process.env.XDT_TAPDB_DEV;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-analytics-'));
  isPackaged = true;
  delete process.env.XDT_TAPDB_DEV;
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  if (originalDevReportingEnv === undefined) delete process.env.XDT_TAPDB_DEV;
  else process.env.XDT_TAPDB_DEV = originalDevReportingEnv;
});

describe('analytics settings store', () => {
  it('defaults to unconsented — nothing may be reported on a fresh install', async () => {
    const store = await importStore();

    expect(store.readAnalyticsSettings()).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: false,
    });
    expect(store.isAnalyticsAllowed()).toBe(false);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('allows reporting only after consent is recorded, and persists it', async () => {
    const store = await importStore();

    store.acceptPrivacyConsent();

    expect(store.isAnalyticsAllowed()).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toMatchObject({
      privacyConsentAccepted: true,
    });

    // 重新加载模块 = 模拟重启,结论必须从磁盘恢复。
    const reloaded = await importStore();
    expect(reloaded.isAnalyticsAllowed()).toBe(true);
  });

  it('keeps consent but stops reporting when the toggle is switched off', async () => {
    const store = await importStore();
    store.acceptPrivacyConsent();

    store.setAnalyticsEnabled(false);

    expect(store.readAnalyticsSettings()).toEqual({
      privacyConsentAccepted: true,
      analyticsEnabled: false,
      legacyConsentMigrationClosed: false,
    });
    expect(store.isAnalyticsAllowed()).toBe(false);

    const reloaded = await importStore();
    expect(reloaded.isAnalyticsAllowed()).toBe(false);
  });

  it('records an explicit re-enable instead of dropping it as "same as default"', async () => {
    const store = await importStore();
    store.acceptPrivacyConsent();
    store.setAnalyticsEnabled(false);

    store.setAnalyticsEnabled(true);

    // analyticsEnabled 的默认值就是 true;不显式留痕的话,「关掉后又打开」会被
    // 当成「从没碰过」,合规问询时无法自证。
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toMatchObject({
      analyticsEnabled: true,
    });
    expect(store.isAnalyticsAllowed()).toBe(true);
  });

  it('migrates a pre-existing signed-in user when the machine has no record', async () => {
    const store = await importStore();

    expect(store.migrateExistingLoginAsConsented(true)).toBe(true);
    expect(store.isAnalyticsAllowed()).toBe(true);
  });

  it('never migrates a signed-out startup', async () => {
    const store = await importStore();

    expect(store.migrateExistingLoginAsConsented(false)).toBe(false);
    expect(store.isAnalyticsAllowed()).toBe(false);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('never overwrites an existing choice — including an explicit opt-out', async () => {
    const store = await importStore();
    store.acceptPrivacyConsent();
    store.setAnalyticsEnabled(false);

    expect(store.migrateExistingLoginAsConsented(true)).toBe(false);
    expect(store.readAnalyticsSettings().analyticsEnabled).toBe(false);
    expect(store.isAnalyticsAllowed()).toBe(false);
  });

  it('normalizes hostile file contents to the safe default', async () => {
    const store = await importStore();

    expect(store.__testing.normalize(null)).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: false,
    });
    // 字符串 'true' 不是布尔,不得被当成同意。
    expect(store.__testing.normalize({ privacyConsentAccepted: 'true' })).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: false,
    });
    expect(store.__testing.normalize({ analyticsEnabled: 0 })).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: false,
    });
    // 字符串 'true' 同样不得把迁移窗口当成已关闭(损坏内容一律回到默认 false,
    // 后续由冷启动判定重新落盘;fail open 到「可迁移」侧的风险由 probe 闸兜底)。
    expect(store.__testing.normalize({ legacyConsentMigrationClosed: 'true' })).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: false,
    });
  });

  it('falls back to unconsented when the file on disk is corrupted', async () => {
    fs.writeFileSync(settingsFile(), '{not json', 'utf-8');
    const store = await importStore();

    expect(store.isAnalyticsAllowed()).toBe(false);
  });

  it('still refuses to migrate when an earlier read already deleted the corrupted file', async () => {
    // 真实启动顺序:renderer 挂载后先发 analytics:settings-get,它早于 auth:initialize。
    // 那次读会把坏 JSON **删掉**并缓存默认态,等迁移执行时盘上已经什么都没有了。
    // 只靠 existsSync 判定会在这里失守,把一份损坏的记录(可能原本是显式 opt-out)
    // 迁移成「已同意 + 默认开启」。
    fs.writeFileSync(settingsFile(), '{not json', 'utf-8');
    const store = await importStore();

    // ① renderer 的首次读取(破坏性:override-settings-file 会 unlink)
    store.readAnalyticsSettings();
    expect(fs.existsSync(settingsFile())).toBe(false);

    // ② 之后才轮到 auth:initialize 触发迁移
    expect(store.migrateExistingLoginAsConsented(true)).toBe(false);
    expect(store.isAnalyticsAllowed()).toBe(false);
  });

  it('refuses to migrate a corrupted record — damaged is not the same as absent', async () => {
    // createOverrideSettingsFile 读到坏 JSON 会把文件删掉并返回 isCustomized=false。
    // 只看 isCustomized 的话,一份损坏的记录(可能原本就是显式 opt-out)会被当成
    // 「从没有过记录」,于是这次冷启动就把采集静默重新打开。
    fs.writeFileSync(settingsFile(), '{not json', 'utf-8');
    const store = await importStore();

    expect(store.migrateExistingLoginAsConsented(true)).toBe(false);
    expect(store.isAnalyticsAllowed()).toBe(false);
  });

  it('clears only the enabled override on reset, keeping the consent fact', async () => {
    const store = await importStore();
    store.acceptPrivacyConsent();
    store.setAnalyticsEnabled(false);
    expect(store.isAnalyticsEnabledCustomized()).toBe(true);

    store.clearAnalyticsEnabledOverride();

    // 拨回 true 会写入一个显式 true,此后跟不上未来的默认值变化;恢复默认必须是
    // 「删掉 override」而不是「写入当前默认值」。
    expect(store.isAnalyticsEnabledCustomized()).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toEqual({
      privacyConsentAccepted: true,
    });
    expect(store.isAnalyticsAllowed()).toBe(true);
  });

  it('tracks whether the toggle was explicitly set', async () => {
    const store = await importStore();
    store.acceptPrivacyConsent();

    // 同意 ≠ 动过开关。
    expect(store.isAnalyticsEnabledCustomized()).toBe(false);

    store.setAnalyticsEnabled(true);
    expect(store.isAnalyticsEnabledCustomized()).toBe(true);
  });

  it('refuses to migrate when a record exists but carries no overrides', async () => {
    fs.writeFileSync(settingsFile(), '{}', 'utf-8');
    const store = await importStore();

    expect(store.migrateExistingLoginAsConsented(true)).toBe(false);
    expect(store.isAnalyticsAllowed()).toBe(false);
  });
});

/**
 * 存量迁移窗口的持久关闭 —— 2026-07-28 review P1。
 *
 * 攻击链:「跳过登录」与企业 SSO 都被协议门刻意豁免、一份记录都不写,于是
 * 「跳过登录 → 从本地模式走登录入口 → 完成 SSO」之后的那次冷启动会看到
 * 「真实账号 + 零记录」,与真正的改版前存量账号无法区分,被静默迁移成已同意。
 * 防线:冷启动一旦明确判定「无存量登录态」,就把结论落盘,本机永久退出迁移窗口。
 */
describe('legacy consent migration window closure', () => {
  it('blocks migration on the next cold start after the window is closed (skip → SSO chain)', async () => {
    // ① 首次冷启动:跳过登录(本地模式),service 判定「无存量登录态」→ 关窗落盘。
    const first = await importStore();
    expect(first.closeLegacyConsentMigration()).toBe(true);

    // ② 用户随后从本地模式走登录入口完成企业 SSO(免协议门,依然零同意记录)。
    // ③ 下一次冷启动恢复出真实账号:重新加载模块 = 模拟重启,结论必须从磁盘恢复。
    const restarted = await importStore();
    expect(restarted.migrateExistingLoginAsConsented(true)).toBe(false);
    expect(restarted.isAnalyticsAllowed()).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>,
    ).not.toHaveProperty('privacyConsentAccepted', true);
  });

  it('is idempotent and does not touch consent or the toggle', async () => {
    const store = await importStore();

    expect(store.closeLegacyConsentMigration()).toBe(true);
    expect(store.closeLegacyConsentMigration()).toBe(false);

    // 关窗是内部标记,不是同意、也不是用户动过开关。
    expect(store.readAnalyticsSettings()).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: true,
    });
    expect(store.isAnalyticsAllowed()).toBe(false);
    expect(store.isAnalyticsEnabledCustomized()).toBe(false);
  });

  it('does not affect a genuine legacy user whose window was never closed', async () => {
    // 真存量用户:改版后第一次冷启动就恢复出真实账号,从未经历「无登录态」冷启动。
    const store = await importStore();

    expect(store.migrateExistingLoginAsConsented(true)).toBe(true);
    expect(store.isAnalyticsAllowed()).toBe(true);
  });

  it('keeps blocking even if a later write rewrites the record file', async () => {
    // 关窗后用户在设置里动了开关 —— 文件被重写,标记必须还在。
    const first = await importStore();
    first.closeLegacyConsentMigration();
    first.setAnalyticsEnabled(false);

    const restarted = await importStore();
    expect(restarted.migrateExistingLoginAsConsented(true)).toBe(false);
    expect(restarted.readAnalyticsSettings().legacyConsentMigrationClosed).toBe(true);
  });
});

/**
 * 构建闸 —— dev 构建绝不上报。
 *
 * dev 的 renderer 从 http://localhost:<vite 端口> 加载、每条 --isolated 沙箱各有独立
 * userData,TapDB 的 device_id 存在 localStorage 里因而每次都是新的,会凭空造出大量
 * 「新增设备」污染线上口径(2026-07-26 复盘)。这一组守的就是那道闸。
 */
describe('analytics build gate', () => {
  it('refuses to report from a dev build even after consent', async () => {
    isPackaged = false;
    const store = await importStore();

    store.acceptPrivacyConsent();

    expect(store.isAnalyticsAllowed()).toBe(false);
    // 闸只挡上报,不得篡改用户的持久真相 —— dev 与正式版常共享同一份 userData。
    expect(store.readAnalyticsSettings()).toEqual({
      privacyConsentAccepted: true,
      analyticsEnabled: true,
      legacyConsentMigrationClosed: false,
    });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toMatchObject({
      privacyConsentAccepted: true,
    });
  });

  it('still reports from a packaged build with the same on-disk record', async () => {
    isPackaged = false;
    const devStore = await importStore();
    devStore.acceptPrivacyConsent();
    expect(devStore.isAnalyticsAllowed()).toBe(false);

    // 同一份盘上记录,换成正式构建立刻放行 —— 证明差异只来自构建 flavor。
    isPackaged = true;
    const packagedStore = await importStore();
    expect(packagedStore.isAnalyticsAllowed()).toBe(true);
  });

  it('lets XDT_TAPDB_DEV=1 opt a dev build back in (link verification escape hatch)', async () => {
    isPackaged = false;
    process.env.XDT_TAPDB_DEV = '1';
    const store = await importStore();

    store.acceptPrivacyConsent();

    expect(store.isAnalyticsAllowed()).toBe(true);
  });

  it('treats any value other than "1" as opted out — no boolean guessing', async () => {
    isPackaged = false;
    for (const raw of ['0', 'true', 'yes', '', ' 1']) {
      process.env.XDT_TAPDB_DEV = raw;
      const store = await importStore();
      store.acceptPrivacyConsent();

      expect(store.isAnalyticsAllowed()).toBe(false);
      expect(store.__testing.isReportingBuild()).toBe(false);
    }
  });

  it('fails closed when the host cannot tell whether the build is packaged', async () => {
    // 非 Electron 宿主 / 不完整 mock:isPackaged 不是严格 true 就按 dev 处理。
    isPackaged = undefined as unknown as boolean;
    const store = await importStore();

    store.acceptPrivacyConsent();

    expect(store.isAnalyticsAllowed()).toBe(false);
  });
});

/**
 * `classifyAnalyticsContent` 是「盘上记录是否可信」判据里不碰 fs 的纯核心
 * （2026-08-04 review copilot：`{}` 与非 boolean 已知字段都不该当 valid）。
 */
describe('classifyAnalyticsContent', () => {
  let classify: (c: string | null) => 'none' | 'valid' | 'invalid';

  beforeEach(async () => {
    classify = (await importStore()).__testing.classifyAnalyticsContent;
  });

  it('文件不存在 ⇒ none', () => {
    expect(classify(null)).toBe('none');
  });

  it('本 writer 会产出的形状 ⇒ valid', () => {
    expect(classify(JSON.stringify({ privacyConsentAccepted: true, analyticsEnabled: false }))).toBe(
      'valid',
    );
  });

  it('⚠️ 空对象 `{}` ⇒ invalid（writer 清空 override 时删文件，从不落 `{}`）', () => {
    expect(classify('{}')).toBe('invalid');
  });

  it('⚠️ 已知字段存在却不是 boolean ⇒ invalid', () => {
    expect(classify(JSON.stringify({ privacyConsentAccepted: 'yes' }))).toBe('invalid');
    expect(classify(JSON.stringify({ analyticsEnabled: 1 }))).toBe('invalid');
    expect(classify(JSON.stringify({ legacyConsentMigrationClosed: null }))).toBe('invalid');
  });

  it('坏 JSON / 非对象 / 数组 ⇒ invalid', () => {
    expect(classify('{ not json')).toBe('invalid');
    expect(classify('"str"')).toBe('invalid');
    expect(classify('[]')).toBe('invalid');
    expect(classify('null')).toBe('invalid');
  });

  it('含未知键但已知字段合法（前向兼容）⇒ valid', () => {
    expect(classify(JSON.stringify({ privacyConsentAccepted: true, futureKey: 1 }))).toBe('valid');
    expect(classify(JSON.stringify({ futureKey: 1 }))).toBe('valid');
  });
});

/**
 * 2026-08-04 review P2：首次把盘上记录分类为 invalid 后，用户重新写入（同意 / 改开关）必须
 * 把缓存探针刷新回可读，否则本会话里日志上报的授权闸一直把同意当「不可读」，手动上报卡在
 * consent-required、崩溃补传卡到重启。
 */
describe('探针在成功写入后刷新（不卡在 invalid）', () => {
  it('损坏文件 ⇒ 不可读；acceptPrivacyConsent 之后 ⇒ 可读', async () => {
    fs.writeFileSync(settingsFile(), 'not-json-corrupt{{');
    const store = await importStore();
    expect(store.isAnalyticsConsentRecordReadable()).toBe(false);

    store.acceptPrivacyConsent();
    expect(store.isAnalyticsConsentRecordReadable()).toBe(true);
    expect(store.readAnalyticsSettings().privacyConsentAccepted).toBe(true);
  });

  it('空对象 {} ⇒ 不可读；setAnalyticsEnabled 之后 ⇒ 可读', async () => {
    fs.writeFileSync(settingsFile(), '{}');
    const store = await importStore();
    expect(store.isAnalyticsConsentRecordReadable()).toBe(false);

    store.setAnalyticsEnabled(false);
    expect(store.isAnalyticsConsentRecordReadable()).toBe(true);
  });
});
