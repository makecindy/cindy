/**
 * analyticsSettingsStore.test.ts —— 使用统计(TapDB)同意闸的持久化行为。
 *
 * 这里测的是合规行为本身,不是配置读写的花样:
 *  - 默认必须是「未同意」,即 allowed=false(fail closed)
 *  - 同意后才允许上报,且开关能独立关掉
 *  - 存量迁移只在本机毫无记录时生效,绝不覆盖用户已有选择
 *
 * 用真实 tmpdir 当 userData(mkdtemp),覆盖到落盘与回读,而不是只测 normalize。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userDataDir : userDataDir) },
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

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-analytics-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('analytics settings store', () => {
  it('defaults to unconsented — nothing may be reported on a fresh install', async () => {
    const store = await importStore();

    expect(store.readAnalyticsSettings()).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
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
    });
    // 字符串 'true' 不是布尔,不得被当成同意。
    expect(store.__testing.normalize({ privacyConsentAccepted: 'true' })).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
    });
    expect(store.__testing.normalize({ analyticsEnabled: 0 })).toEqual({
      privacyConsentAccepted: false,
      analyticsEnabled: true,
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
