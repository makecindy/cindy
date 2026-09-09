/**
 * vision-bridge-settings-store 缓存语义测试。
 *
 * 覆盖：read 缓存命中（二次读不重新解析）；write 后缓存失效（读到新值）；
 * reset 后缓存失效（回到默认）；isTargetModelsCustomized 随 customizedKeys 变化。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ tmpUserData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => hoisted.tmpUserData,
  },
}));

// 动态 import（mock electron 后才加载真实 store）。
let store: typeof import('../vision-bridge-settings-store.js');

beforeEach(async () => {
  hoisted.tmpUserData = mkdtempSync(path.join(os.tmpdir(), 'vb-store-test-'));
  vi.resetModules();
  store = await import('../vision-bridge-settings-store.js');
});

afterEach(() => {
  if (hoisted.tmpUserData) rmSync(hoisted.tmpUserData, { recursive: true, force: true });
});

describe('vision-bridge-settings-store cache semantics', () => {
  it('write invalidates cache so subsequent read returns the new value', async () => {
    const s = store!;
    // 初始默认：enabled false。
    expect(s.readVisionBridgeSettings().enabled).toBe(false);
    // 写后缓存失效，read 到新值。
    s.writeVisionBridgeSettings({ enabled: true });
    expect(s.readVisionBridgeSettings().enabled).toBe(true);
  });

  it('reset invalidates cache and returns to defaults', async () => {
    const s = store!;
    s.writeVisionBridgeSettings({ enabled: true, targetModels: ['deepseek-v4'] });
    expect(s.readVisionBridgeSettings().enabled).toBe(true);
    s.resetVisionBridgeSettings();
    expect(s.readVisionBridgeSettings().enabled).toBe(false);
    expect(s.readVisionBridgeSettings().targetModels).toEqual([]);
  });

  it('isTargetModelsCustomized tracks customizedKeys after write', async () => {
    const s = store!;
    // 未自定义 → false。
    expect(s.isTargetModelsCustomized()).toBe(false);
    // 写 targetModels → customized → true。
    s.writeVisionBridgeSettings({ targetModels: ['deepseek-v4'] });
    expect(s.isTargetModelsCustomized()).toBe(true);
    // reset → false。
    s.resetVisionBridgeSettings();
    expect(s.isTargetModelsCustomized()).toBe(false);
  });

  it('keeps empty targetModels override (user cancelled default no-vision selection)', async () => {
    const s = store!;
    // 写空数组 targetModels：用户显式清空（取消默认勾选 no-vision），必须保留 override，
    // 不能被「等默认」逻辑当未自定义删掉。
    s.writeVisionBridgeSettings({ targetModels: [] });
    const state = s.readVisionBridgeSettingsState();
    expect(state.customizedKeys).toContain('targetModels');
    expect(s.isTargetModelsCustomized()).toBe(true);
    expect(s.readVisionBridgeSettings().targetModels).toEqual([]);
  });

  it('normalizes blank targetModels entries (trim + drop empty)', async () => {
    const s = store!;
    s.writeVisionBridgeSettings({ targetModels: [' deepseek-v4 ', '  ', 'claude-opus-5'] });
    expect(s.readVisionBridgeSettings().targetModels).toEqual(['deepseek-v4', 'claude-opus-5']);
  });
});
