import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', owner: 'a', pending: false }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  ownerScopedUserDataPath: (name: string) => state.root + '/' + state.owner + '/' + name,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
import { readRemoteAgentLimitsState, saveRemoteAgentLimits } from '../host/limitsStore';
import { isRemoteAgentLimits } from '../../../shared/remoteAgentLimits';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-limit-store-'));
  state.owner = 'a'; state.pending = false;
});
afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

describe('remote task limit overrides', () => {
  it('only persists supplied fields and preserves earlier explicit choices', async () => {
    await saveRemoteAgentLimits({ perDevice: 24 });
    expect(readRemoteAgentLimitsState()).toMatchObject({
      value: { perDevice: 24, total: 64 }, customizedKeys: ['perDevice'],
    });
    expect(JSON.parse(await fs.readFile(path.join(state.root, 'a', 'remote-agent-limits.json'), 'utf8'))).toEqual({ perDevice: 24 });
    await saveRemoteAgentLimits({ total: 80 });
    await saveRemoteAgentLimits({ perDevice: 16 });
    expect(readRemoteAgentLimitsState()).toMatchObject({
      value: { perDevice: 16, total: 80 }, customizedKeys: ['perDevice', 'total'],
    });
    await expect(saveRemoteAgentLimits({ total: 8 })).rejects.toThrow('INVALID_PARAMS');
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 16, total: 80, idleMinutes: 30 });
  });

  it('validates concurrent partial updates against the value inside the write lock', async () => {
    await saveRemoteAgentLimits({ perDevice: 16, total: 64 });
    const results = await Promise.allSettled([
      saveRemoteAgentLimits({ perDevice: 60 }), saveRemoteAgentLimits({ total: 32 }),
    ]);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(isRemoteAgentLimits(readRemoteAgentLimitsState().value)).toBe(true);
  });
  it('keeps explicit defaults, isolates accounts, and resets by deleting overrides', async () => {
    expect(readRemoteAgentLimitsState().isCustomized).toBe(false);
    await saveRemoteAgentLimits({ perDevice: 16, total: 64 });
    expect(readRemoteAgentLimitsState().customizedKeys).toEqual(['perDevice', 'total']);
    await saveRemoteAgentLimits({ perDevice: 32, total: 128 });
    state.owner = 'b';
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 16, total: 64, idleMinutes: 30 });
    state.owner = 'a';
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 32, total: 128, idleMinutes: 30 });
    await saveRemoteAgentLimits(null);
    expect(readRemoteAgentLimitsState()).toMatchObject({ isCustomized: false, value: { perDevice: 16, total: 64, idleMinutes: 30 } });
  });
  // provider-sharing.md §3「闲置收回由提供方决定」：旧版写下的设置文件没有这一项时按默认 30 读；
  // 0 是有效的「不收回」，只存用户改过的这一项，不改动另外两项的覆盖。
  it('reads idle reclaim minutes from files written before the setting existed and stores 0 as an explicit choice', async () => {
    await fs.mkdir(path.join(state.root, 'a'), { recursive: true });
    await fs.writeFile(path.join(state.root, 'a', 'remote-agent-limits.json'), JSON.stringify({ perDevice: 24 }));
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 24, total: 64, idleMinutes: 30 });
    await saveRemoteAgentLimits({ idleMinutes: 0 });
    expect(readRemoteAgentLimitsState()).toMatchObject({
      value: { perDevice: 24, total: 64, idleMinutes: 0 }, customizedKeys: ['perDevice', 'idleMinutes'],
    });
    expect(JSON.parse(await fs.readFile(path.join(state.root, 'a', 'remote-agent-limits.json'), 'utf8')))
      .toEqual({ perDevice: 24, idleMinutes: 0 });
  });
  it.each([
    { perDevice: 0, total: 64 }, { perDevice: 2, total: 1 },
    { perDevice: 1.5, total: 64 }, { perDevice: 16, total: 1001 },
    { perDevice: NaN, total: 64 }, { perDevice: 16, total: Infinity },
    { perDevice: 16, total: 64, idleMinutes: -1 }, { perDevice: 16, total: 64, idleMinutes: 1441 },
    { perDevice: 16, total: 64, idleMinutes: 2.5 },
  ])('rejects invalid settings %j', async value => {
    expect(isRemoteAgentLimits(value)).toBe(false);
    await expect(saveRemoteAgentLimits(value)).rejects.toThrow('INVALID_PARAMS');
    expect(readRemoteAgentLimitsState().isCustomized).toBe(false);
  });
  it('rejects writes during account teardown', async () => {
    state.pending = true;
    await expect(saveRemoteAgentLimits({ perDevice: 4, total: 8 })).rejects.toThrow('PRECONDITION_FAILED');
  });
});
