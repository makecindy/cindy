/**
 * 组内电脑冷却的落盘(docs/product-rules/provider-groups.md §5)：写入要和所在文件当前内容合并
 * (按 provider + 成员取较晚结束时间)，不能直接用调用方那份快照覆盖——否则连续冷却两台电脑时，
 * 早开始、后拿到文件锁的写入会把已经落地的那一台冷却挤丢(greptile-apps P1, PR #5792 review)。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_GROUP_STORAGE_MEMBER_CAP } from '../../../shared/providerGroup.js';
import { PROVIDER_GROUP_COOLING_SCOPE_CAP } from '../cooling.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-cooling-store-test-'));
let caseDir = tmpDir;

vi.mock('electron', () => ({ app: { getPath: () => caseDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(caseDir, name),
  activeOwnerScopeKey: () => caseDir,
}));

const coolingStore = await import('../coolingStore.js');
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('冷却记录的成员边界', () => {
  it('保留配置允许的全部成员，仍拒绝超出存储边界的条目', () => {
    const members = Object.fromEntries(Array.from({ length: PROVIDER_GROUP_STORAGE_MEMBER_CAP + 1 }, (_, i) => [`device:d${i}:anthropic`, 5000]));
    const result = coolingStore.__testing.normalize({ cooling: { anthropic: members } }).cooling.anthropic!;
    expect(Object.keys(result)).toHaveLength(PROVIDER_GROUP_STORAGE_MEMBER_CAP);
    expect(result[`device:d${PROVIDER_GROUP_STORAGE_MEMBER_CAP - 1}:anthropic`]).toBe(5000);
    expect(result).not.toHaveProperty(`device:d${PROVIDER_GROUP_STORAGE_MEMBER_CAP}:anthropic`);
  });
});

describe('mergeCooling', () => {
  const { mergeCooling } = coolingStore.__testing;

  it('merges independent model limits without widening them, and bounds legacy records during migration', () => {
    expect(mergeCooling(
      { anthropic: { local: { 'claude:fable': 500_000, 'claude:opus': 500 } } },
      { anthropic: { local: { 'claude:sonnet': 400_000, 'claude:fable': 300_000 } } },
      1_000,
    )).toEqual({ anthropic: { local: { 'claude:fable': 500_000, 'claude:sonnet': 400_000 } } });
    expect(mergeCooling({ anthropic: { local: 86_400_000 } }, {}, 1_000))
      .toEqual({ anthropic: { local: { '': 121_000 } } });
    // 旧数字已在加载时截短；排队写入不能按拿锁时间重新延长，过期后也不能复活。
    const legacy = { anthropic: { local: 86_400_000 } };
    const migrated = { anthropic: { local: { '': 121_000 } } };
    expect(mergeCooling(legacy, migrated, 60_000)).toEqual(migrated);
    expect(mergeCooling(legacy, migrated, 180_000)).toEqual({});
  });

  it('keeps both members when they are in different snapshots', () => {
    expect(mergeCooling(
      { anthropic: { 'device:mini:a': { '': 1_000 } } },
      { anthropic: { 'device:studio:a': { '': 2_000 } } },
      0,
    )).toEqual({
      anthropic: { 'device:mini:a': { '': 1_000 }, 'device:studio:a': { '': 2_000 } },
    });
  });

  it('keeps the later end time for the same member instead of blindly overwriting', () => {
    // 旧快照里这一台冷却到 5000，调用方这次只带着更早算出的 3000(比如基于稍旧的内存状态)：
    // 不应该把已经落地的更晚结束时间往回改。
    expect(mergeCooling(
      { anthropic: { 'device:mini:a': { '': 5_000 } } },
      { anthropic: { 'device:mini:a': { '': 3_000 } } },
      0,
    )).toEqual({
      anthropic: { 'device:mini:a': { '': 5_000 } },
    });
    expect(mergeCooling(
      { anthropic: { 'device:mini:a': { '': 3_000 } } },
      { anthropic: { 'device:mini:a': { '': 5_000 } } },
      0,
    )).toEqual({
      anthropic: { 'device:mini:a': { '': 5_000 } },
    });
  });

  it('merges across providers too', () => {
    expect(mergeCooling(
      { anthropic: { a: { '': 1 } } },
      { openai: { b: { '': 2 } } },
      0,
    )).toEqual({ anthropic: { a: { '': 1 } }, openai: { b: { '': 2 } } });
  });

  it('到期条目从两份快照移除，未到期的并发冷却保留较晚结束时间', () => {
    expect(mergeCooling(
      { anthropic: { old: 99, boundary: 100, active: { '': 200 } }, openai: { old: 1 } },
      { anthropic: { stale: 50, active: 150, fresh: { '': 300 } } },
      100,
    )).toEqual({ anthropic: { active: { '': 200 }, fresh: { '': 300 } } });
  });
});

describe('writeProviderGroupCooling (real file)', () => {
  // #6928 Windows CI: the large-file case must not make later writes reprocess
  // its payload or let a late write leak into the next test's assertions.
  beforeEach(() => { caseDir = fs.mkdtempSync(path.join(tmpDir, 'case-')); });

  it('512 个成员各有 64 个模型范围时全部写入并在重启读取后保留', async () => {
    // PR #6322 review: 单范围用例低于旧 1 MiB 上限，无法发现多模型冷却整次写入失败。
    // unit: 经真实写入/重启读取入口覆盖超过旧预算的合法多范围记录。
    const providerId = 'p'.repeat(128);
    const scopes = Object.fromEntries(Array.from({ length: PROVIDER_GROUP_COOLING_SCOPE_CAP }, (_, i) => [
      `model:${String(i).padStart(40, 'm')}`, Number.MAX_VALUE,
    ]));
    const members = Object.fromEntries(Array.from({ length: PROVIDER_GROUP_STORAGE_MEMBER_CAP }, (_, i) => [
      `device:${String(i).padStart(164, 'd')}:${providerId}`, scopes,
    ]));
    await coolingStore.writeProviderGroupCooling({ [providerId]: members });
    const file = path.join(caseDir, 'provider-group-cooling.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cooling[providerId]).toEqual(members);
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);
    // 新实例没有旧 store 的缓存，直接从实际文件恢复。
    // reset-modules: verify persisted cooldowns survive a fresh store instance.
    vi.resetModules();
    const restarted = await import('../coolingStore.js');
    expect(restarted.readProviderGroupCooling()[providerId]).toEqual(members);
  });

  it('keeps an earlier cooldown instead of discarding it on the next write (greptile-apps P1)', async () => {
    // 模拟 PR 场景:两台电脑先后撞上限额。修复前的实现每次 updateAtomic 都是整份覆盖,
    // 谁最后拿到锁谁就是最终结果;修复后每次写入在锁内和当前文件内容合并,谁先谁后都不会挤丢对方。
    const now = Date.now();
    const studioUntil = now + 120_000;
    const miniUntil = now + 60_000;
    let release!: () => void;
    let blocked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { blocked = resolve; });
    const open = fsp.open.bind(fsp);
    let attempts = 0;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      if (String(args[0]).endsWith('provider-group-cooling.json.lock') && ++attempts === 2) {
        blocked(); await held;
      }
      return open(...args);
    });
    let finished = false;
    const writes = Promise.all([
      coolingStore.writeProviderGroupCooling({ anthropic: { 'device:studio:a': { '': studioUntil } } }),
      coolingStore.writeProviderGroupCooling({ anthropic: { 'device:mini:a': { '': miniUntil } } }),
    ]).then(() => { finished = true; });
    try {
      await waiting;
      // A healthy write can outlive polling budgets. Its completion signal
      // must remain pending until that write, not merely its dispatch, ends.
      expect(finished).toBe(false);
      release(); await writes;
      expect(coolingStore.readProviderGroupCooling().anthropic).toEqual({ 'device:studio:a': { '': studioUntil }, 'device:mini:a': { '': miniUntil } });
    } finally {
      try {
        release();
        await writes;
        await vi.waitFor(() => expect(coolingStore.readProviderGroupCooling().anthropic).toEqual({ 'device:studio:a': { '': studioUntil }, 'device:mini:a': { '': miniUntil } }));
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('旧文件的 512 个已过期成员释放容量，新成员冷却写盘并在重启后保留', async () => {
    const now = Date.now();
    const expired = Object.fromEntries(Array.from({ length: PROVIDER_GROUP_STORAGE_MEMBER_CAP }, (_, i) => [`device:old${i}:openai`, now - 1000]));
    const file = path.join(caseDir, 'provider-group-cooling.json');
    // 模拟旧版已经写满的文件；当前新版写入不能再把过期条目并回来。
    const current = { anthropic: { 'device:studio:a': { '': now + 120_000 } } };
    fs.writeFileSync(file, JSON.stringify({ cooling: { ...current, openai: expired } }));
    const next = { 'device:new:openai': { '': now + 60_000 } };
    await coolingStore.writeProviderGroupCooling({ openai: next });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cooling.openai).toEqual(next);
    // reset-modules: verify persisted cooldowns survive a fresh store instance.
    vi.resetModules();
    const restarted = await import('../coolingStore.js');
    expect(restarted.readProviderGroupCooling().openai).toEqual(next);
    expect(restarted.readProviderGroupCooling().anthropic).toEqual(current.anthropic);
  });
});
