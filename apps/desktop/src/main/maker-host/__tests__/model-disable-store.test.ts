/**
 * model-disable-store.test.ts — 「模型 / 供应商停用」override 存储的单测。
 * 覆盖 normalize(坏形态清洗)与单 section 总量硬上限(深防线);userData 落盘经
 * mock 的 ownerScopedUserDataPath 指向本测试专属临时目录,读写链路走真文件。
 * IPC 边界的入参 / 目录成员校验由 providerHandlers 测试覆盖(规则 14)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-disable-store-test-'));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
}));

const { __testing, setModelsDisabled } = await import('../model-disable-store.js');

function readPrefsFile(): { disabledModels: Record<string, unknown> } {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, 'model-disable-prefs.json'), 'utf8'),
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
      }),
    ).toEqual({
      disabledModels: { 'xd:claude-opus-5': true },
      disabledProviders: { anthropic: true },
    });
  });

  it('整体不是对象 / 段缺失 / 段不是对象 → 空表(全启用)', () => {
    expect(__testing.normalize(null)).toEqual({ disabledModels: {}, disabledProviders: {} });
    expect(__testing.normalize({})).toEqual({ disabledModels: {}, disabledProviders: {} });
    expect(__testing.normalize({ disabledModels: 42, disabledProviders: 'x' })).toEqual({
      disabledModels: {},
      disabledProviders: {},
    });
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

describe('单 section 总量硬上限(深防线)', () => {
  it('disabledModels 超上限的新增被丢弃;删除不受上限影响、可继续腾出空间', () => {
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
