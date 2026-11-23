/**
 * model-disable-store.test.ts — 「模型 / 供应商停用」override 存储的单测。
 * 覆盖 normalize(坏形态清洗)与单 section 总量硬上限(深防线);userData 落盘经
 * mock 的 ownerScopedUserDataPath 指向本测试专属临时目录,读写链路走真文件。
 * IPC 边界的入参 / 目录成员校验由 providerHandlers 测试覆盖(规则 14)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, it, expect, vi } from 'vitest';
import { isModelDisabled } from '@cindy/model-providers';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-disable-store-test-'));
let prefsDir = tmpDir;
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { info: () => {}, warn: () => {}, child: () => ({ info: () => {}, warn: () => {} }) },
}));
vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return {
    ...actual,
    activeOwnerScopeKey: () => prefsDir,
    ownerScopedUserDataPath: (...parts: string[]) => path.join(prefsDir, ...parts),
  };
});
vi.mock('../../ownerContext.js', () => ({
  configureOwnerContext: () => {},
  ownerScopedPath: (name: string) => path.join(prefsDir, name),
  ownerGeneration: () => 0,
  hasCommittedOwner: () => true,
}));
vi.mock('../../subscription-accounts/placement.js', () => ({
  readCreatedSubscriptionProvidersIfReadable: () => ({
    'openai-sub-1234abcd': { kind: 'openai', name: 'Split', account: 'fixture-account' },
    'openai-sub-5678abcd': { kind: 'openai', name: 'Other split', account: 'other-account' },
  }),
}));

const { __testing, migrateLegacyNamespacedModelDisableOverrides, setModelsDisabled,
  copyProviderDisableOverrides, clearProviderDisableOverrides, setProviderDisabled,
  setProviderHidden, stageProviderDisableOverridesClear, readModelDisableOverrides } =
  await import('../model-disable-store.js');

function readPrefsFile(): { disabledModels: Record<string, unknown> } {
  return JSON.parse(
    fs.readFileSync(path.join(prefsDir, 'model-disable-prefs.json'), 'utf8'),
  ) as { disabledModels: Record<string, unknown> };
}

describe('normalize(坏形态清洗)', () => {
  it('只保留 value === true 的条目;false / 非布尔 / 空 key 一律丢弃 = 启用', () => {
    expect(
      __testing.normalize({
        disabledModels: {
          'xd:claude-opus-5': true,
          'xd:claude-sonnet-5': false,
          'xd:gpt-5.5': 'yes',
          '': true,
        },
        disabledProviders: { anthropic: true, openai: 0 },
        hiddenProviders: { xd: true, anthropic: 'yes' },
      }),
    ).toEqual({
      disabledModels: { 'xd:claude-opus-5': true },
      disabledProviders: { anthropic: true },
      hiddenProviders: { xd: true },
    });
  });

  it('整体不是对象 / 段缺失 / 段不是对象 → 空表(全启用)', () => {
    const empty = { disabledModels: {}, disabledProviders: {}, hiddenProviders: {} };
    expect(__testing.normalize(null)).toEqual(empty);
    // 旧版文件没有 hiddenProviders 段:升级后等同「没有隐藏任何供应商」。
    expect(__testing.normalize({})).toEqual(empty);
    expect(__testing.normalize({ disabledModels: 42, disabledProviders: 'x', hiddenProviders: [] })).toEqual(empty);
  });

  it('读入同样截断到单 section 上限:手改/灌大的文件不被完整持有与重写放大', () => {
    const raw = {
      disabledModels: Object.fromEntries(
        Array.from({ length: 5000 }, (_v, i) => [`p:m-${i}`, true]),
      ),
      disabledProviders: {},
    };
    expect(Object.keys(__testing.normalize(raw).disabledModels)).toHaveLength(4096);
  });
});

describe('旧媒体 modelId 停用项迁移', () => {
  it('只把唯一 basename 匹配迁移为完整 modelId', () => {
    setModelsDisabled('legacy-xd', ['gpt-image-2'], true);
    migrateLegacyNamespacedModelDisableOverrides('legacy-xd', ['openai/gpt-image-2']);
    expect(readPrefsFile().disabledModels).toMatchObject({
      'legacy-xd:openai/gpt-image-2': true,
    });
    expect(readPrefsFile().disabledModels['legacy-xd:gpt-image-2']).toBeUndefined();

    setModelsDisabled('ambiguous-xd', ['gpt-image-2'], true);
    migrateLegacyNamespacedModelDisableOverrides('ambiguous-xd', [
      'openai/gpt-image-2',
      'other/gpt-image-2',
    ]);
    expect(readPrefsFile().disabledModels['ambiguous-xd:gpt-image-2']).toBe(true);
    expect(readPrefsFile().disabledModels['ambiguous-xd:openai/gpt-image-2']).toBeUndefined();
  });

  // #12129 reviews, unit: recover off switches copied during a split in either
  // direction. The native-connection proof is the actual owner-scoped pool file.
  it.each([
    ['openai', 'openai-sub-1234abcd'],
    ['codex-native-old', 'openai-sub-1234abcd'],
    ['openai-sub-1234abcd', 'codex-native-old'],
  ])('recovers the image disable copied from %s to %s until explicitly enabled', async (sourceId, provider) => {
    const other = 'openai-sub-5678abcd';
    const unregistered = 'openai-sub-9999abcd';
    const oldId = `${sourceId}/gpt-image-2`;
    const image = `${provider}/gpt-image-2`;
    const otherImage = `${other}/gpt-image-2`;
    prefsDir = fs.mkdtempSync(path.join(tmpDir, 'legacy-image-'));
    const file = path.join(prefsDir, 'model-disable-prefs.json');
    const unchanged = {
      [`${sourceId}:${oldId}`]: true,
      [`${provider}:fixture-chat`]: true,
      [`${provider}:different/gpt-image-2`]: true,
      [`${provider}:${sourceId}/gpt-image-2-preview`]: true,
      [`${provider}:${sourceId}-unrelated/gpt-image-2`]: true,
      [`${unregistered}:${oldId}`]: true,
    };
    const legacy = {
      ...unchanged,
      [`${provider}:${oldId}`]: true,
      [`${other}:${oldId}`]: true,
      [`${other}:${otherImage}`]: true,
    };
    fs.writeFileSync(file, JSON.stringify({ disabledModels: legacy, hiddenProviders: { [other]: true } }));
    if (sourceId !== 'openai') {
      const accountId = 'cindy-123456789abc-12345678-1234-1234-1234-123456789abc';
      fs.writeFileSync(path.join(prefsDir, 'subscription-accounts.json'), JSON.stringify({
        pools: { openai: {
          strategy: 'least', accounts: [{ id: accountId }], legacyCodexAccounts: { 'codex-native-old': accountId },
        } },
      }));
    }
    try {
      const normalized = { ...unchanged, [`${provider}:${image}`]: true, [`${other}:${otherImage}`]: true };
      expect(readModelDisableOverrides().disabledModels).toEqual(normalized);
      expect(readModelDisableOverrides().disabledModels).toEqual(normalized);
      expect(readPrefsFile().disabledModels).toEqual(legacy); // Pure reads do not rewrite preferences.
      setModelsDisabled(provider, [image], false);
      expect(readPrefsFile()).toEqual({
        disabledModels: { ...unchanged, [`${other}:${otherImage}`]: true },
        hiddenProviders: { [other]: true },
      });

      // reset-modules: simulate restart with only the persisted preferences, not the store cache.
      vi.resetModules();
      const restarted = await import('../model-disable-store.js');
      const isDisabled = () => isModelDisabled(restarted.readModelDisableOverrides(), provider, image);
      expect(isDisabled()).toBe(false);
      restarted.setModelsDisabled(provider, [image], true);
      expect(isDisabled()).toBe(true);
      expect(readPrefsFile().disabledModels[`${provider}:${oldId}`]).toBeUndefined();
      restarted.setModelsDisabled(provider, [image], false);
      expect(isDisabled()).toBe(false);
      if (sourceId !== 'openai') {
        // Same provider IDs in another owner without the native source registration
        // cannot borrow the first owner's evidence.
        prefsDir = fs.mkdtempSync(path.join(tmpDir, 'other-owner-'));
        fs.writeFileSync(path.join(prefsDir, 'model-disable-prefs.json'), JSON.stringify({
          disabledModels: { [`${provider}:${oldId}`]: true },
        }));
        expect(isDisabled()).toBe(false);
        expect(readPrefsFile().disabledModels).toEqual({ [`${provider}:${oldId}`]: true });
      }
    } finally {
      prefsDir = tmpDir;
    }
  });
});

// PR #10405, unit: taking an account out must keep the source model switches. This checks the
// production store's actual persisted values, which account-selection mocks cannot cover.
it('copies model access overrides before publishing a separate subscription provider', () => {
  const target = 'openai-sub-12345678';
  setModelsDisabled('openai', ['gpt-6', 'openai/gpt-image-2'], true);
  setProviderDisabled('openai', true);
  copyProviderDisableOverrides('openai', target, {
    source: 'openai/gpt-image-2', target: `${target}/gpt-image-2`,
  });
  expect(readPrefsFile()).toMatchObject({ disabledModels: {
    'openai:gpt-6': true, 'openai:openai/gpt-image-2': true,
    [`${target}:gpt-6`]: true, [`${target}:${target}/gpt-image-2`]: true,
  }, disabledProviders: { [target]: true } });
  expect(readPrefsFile().disabledModels[`${target}:openai/gpt-image-2`]).toBeUndefined();
  clearProviderDisableOverrides('openai');
  clearProviderDisableOverrides(target);
});

// 依据:隐藏只收起选择器里的陈列,停用才是准入;两者写在同一文件里,最容易出的错是
// 一个动作顺手改掉另一个。这里经真实落盘验证三条边界(tier: unit,真文件读写)。
describe('供应商级隐藏与停用互不牵连', () => {
  it('隐藏不写停用;「全部启用」清停用但保留隐藏;删除供应商才一并清掉且可恢复', () => {
    setProviderHidden('xd', true);
    expect(readModelDisableOverrides()).toMatchObject({ hiddenProviders: { xd: true }, disabledProviders: {} });

    setProviderDisabled('xd', true);
    setModelsDisabled('xd', ['gpt-6'], true);
    clearProviderDisableOverrides('xd'); // 设置页「全部启用」走的就是这条
    expect(readModelDisableOverrides()).toMatchObject({
      hiddenProviders: { xd: true }, disabledProviders: {}, disabledModels: {},
    });

    const restore = stageProviderDisableOverridesClear('xd'); // 删除供应商事务
    expect(readModelDisableOverrides().hiddenProviders).toEqual({});
    expect(restore()).toBe(true); // 删除失败回滚:隐藏原样回来
    expect(readModelDisableOverrides().hiddenProviders).toEqual({ xd: true });

    setProviderHidden('xd', false);
    expect(readPrefsFile()).not.toHaveProperty('hiddenProviders.xd');
  });
});

describe('单 section 总量硬上限(深防线)', () => {
  it('disabledModels 超上限的新增被丢弃;删除不受上限影响、可继续腾出空间', () => {
    setModelsDisabled('legacy-xd', ['gpt-image-2', 'openai/gpt-image-2'], false);
    setModelsDisabled(
      'ambiguous-xd',
      ['gpt-image-2', 'openai/gpt-image-2', 'other/gpt-image-2'],
      false,
    );
    // IPC 边界单次 ≤512,但 store 是最后一道防线:未来新增写入口 / 手改文件绕过
    // 边界时,section 不得无界膨胀。一次灌 5000 个 → 只落 4096。
    const ids = Array.from({ length: 5000 }, (_v, i) => `m-${i}`);
    setModelsDisabled('cap-p', ids, true);
    expect(Object.keys(readPrefsFile().disabledModels)).toHaveLength(4096);

    // 满员时删除照常生效(恢复启用 = 删条目,永不被上限挡住)……
    setModelsDisabled('cap-p', ['m-0', 'm-1'], false);
    const afterDelete = readPrefsFile().disabledModels;
    expect(Object.keys(afterDelete)).toHaveLength(4094);
    // ……且同一批写入里删出来的空位可立刻被新增复用(计数是滚动的,不是快照)。
    setModelsDisabled('cap-p', ['m-4998', 'm-4999'], true);
    expect(Object.keys(readPrefsFile().disabledModels)).toHaveLength(4096);
    expect(readPrefsFile().disabledModels['cap-p:m-0']).toBeUndefined();
    expect(readPrefsFile().disabledModels['cap-p:m-4999']).toBe(true);
  });
});
