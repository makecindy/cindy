/**
 * 转分享的同意(分享者这台电脑，docs/product-rules/provider-sharing.md §4.3)：受邀者的组所在电脑整体报上它分享的人，
 * 新出现的人等主人处理；主人的决定保留到那个人不再被报上来；同意只认报上来的那台组所在电脑与那个人。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { providerShareGuestPeer } from '@cindy/device-link';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-reshare-test-'));
const access = vi.hoisted(() => ({ active: true }));

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
  activeOwnerScopeKey: () => 'owner-test',
}));
vi.mock('../providerShareHost.js', () => ({
  providerShareGuestAccess: () => (access.active ? { shareId: 'a-share', memberId: 'b-member', providerId: 'anthropic' } : null),
}));

const reshare = await import('../providerShareReshare.js');
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const B_GROUP = providerShareGuestPeer('a-share', 'b-member', 'b-device');
const B_OTHER_DEVICE = providerShareGuestPeer('a-share', 'b-member', 'b-laptop');
const CAROL = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const DAVE = 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1';

function manyEntries(count: number): Array<{ key: string; name: string }> {
  return Array.from({ length: count }, (_, index) => ({
    key: index.toString(16).padStart(32, '0'),
    name: 'Person ' + index,
  }));
}

beforeEach(async () => {
  access.active = true;
  reshare.setProviderShareReshareEvents(null);
  await reshare.pruneProviderShareReshares(() => true);
});

describe('provider share reshare consent (sharer computer)', () => {
  it('keeps a reshare pending when account teardown begins while waiting for the decision write lock', async () => {
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }]);
    const record = reshare.listProviderShareReshares()[0]!;
    let current = true;
    const pending = reshare.decideProviderShareReshare(record.id, 'approve', Date.now(), () => {
      if (!current) throw new Error('[PRECONDITION_FAILED] The account changed');
    });
    current = false;
    await expect(pending).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(reshare.listProviderShareReshares()[0]).toEqual(record);
    expect(reshare.providerShareReshareAllows(B_GROUP, CAROL)).toBe(false);
  });

  it('records newly reported people as pending and tells the owner once', async () => {
    const requested = vi.fn();
    reshare.setProviderShareReshareEvents({ requested, changed: vi.fn(), revoked: vi.fn() });
    expect(await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol', avatar: 'https://cdn.example.com/c.png' }]))
      .toEqual({ entries: [{ key: CAROL, state: 'pending' }] });
    expect(requested).toHaveBeenCalledTimes(1);
    expect(requested.mock.calls[0][0]).toEqual([expect.objectContaining({
      shareId: 'a-share', memberId: 'b-member', deviceId: 'b-device', key: CAROL, name: 'Carol', state: 'pending',
    })]);
    // 同一份再报一次：不重复提醒。
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }]);
    expect(requested).toHaveBeenCalledTimes(1);
    expect(reshare.providerShareReshareAllows(B_GROUP, CAROL)).toBe(false);
  });

  it('allows a relayed task only after the owner agrees, only for that group computer and that person', async () => {
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }, { key: DAVE, name: 'Dave' }]);
    const carol = reshare.listProviderShareReshares().find((record) => record.key === CAROL)!;
    expect(await reshare.decideProviderShareReshare(carol.id, 'approve')).toMatchObject({ previous: 'pending', record: { state: 'approved' } });
    expect(reshare.providerShareReshareAllows(B_GROUP, CAROL)).toBe(true);
    expect(reshare.providerShareReshareAllows(B_GROUP, DAVE)).toBe(false);
    expect(reshare.providerShareReshareAllows(B_GROUP, undefined)).toBe(false);
    // 同一个受邀者的另一台电脑没有报过这个人。
    expect(reshare.providerShareReshareAllows(B_OTHER_DEVICE, CAROL)).toBe(false);
    expect(reshare.providerShareReshareAllows('same-account-mac', CAROL)).toBe(false);
    // 主人的决定在重新报上来时保留。
    expect(await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol (new name)' }, { key: DAVE, name: 'Dave' }]))
      .toEqual({ entries: [{ key: CAROL, state: 'approved' }, { key: DAVE, state: 'pending' }] });
    expect(reshare.listProviderShareReshares().find((record) => record.key === CAROL)?.name).toBe('Carol (new name)');
  });

  it('withdrawing or no longer reporting an agreed person ends their relayed tasks', async () => {
    const revoked = vi.fn();
    reshare.setProviderShareReshareEvents({ requested: vi.fn(), changed: vi.fn(), revoked });
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }, { key: DAVE, name: 'Dave' }]);
    for (const record of reshare.listProviderShareReshares()) await reshare.decideProviderShareReshare(record.id, 'approve');
    // 主人撤回(拒绝已同意的)：调用方据 previous 结束任务。
    const dave = reshare.listProviderShareReshares().find((record) => record.key === DAVE)!;
    expect(await reshare.decideProviderShareReshare(dave.id, 'reject')).toMatchObject({ previous: 'approved', record: { state: 'rejected' } });
    expect(reshare.providerShareReshareAllows(B_GROUP, DAVE)).toBe(false);
    // 组所在电脑不再报上 Carol(那人已不在它的分享里)：删掉并结束她的任务。
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: DAVE, name: 'Dave' }]);
    expect(revoked).toHaveBeenCalledWith([expect.objectContaining({ key: CAROL, state: 'approved' })]);
    expect(reshare.listProviderShareReshares().map((record) => record.key)).toEqual([DAVE]);
    // 拒绝过的人照旧保留主人的决定。
    expect(reshare.listProviderShareReshares()[0]?.state).toBe('rejected');
  });

  it('notifies the owner when pending or rejected people disappear from the report', async () => {
    const changed = vi.fn();
    reshare.setProviderShareReshareEvents({ requested: vi.fn(), changed, revoked: vi.fn() });
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }, { key: DAVE, name: 'Dave' }]);
    const dave = reshare.listProviderShareReshares().find((record) => record.key === DAVE)!;
    await reshare.decideProviderShareReshare(dave.id, 'reject');
    changed.mockClear();

    await reshare.handleProviderShareReshare(B_GROUP, []);

    expect(changed).toHaveBeenCalledOnce();
    expect(reshare.listProviderShareReshares()).toEqual([]);
  });

  it('only accepts reports from an active shared user', async () => {
    access.active = false;
    await expect(reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }])).rejects.toThrow(/REMOTE_AGENT_INVALID/);
    access.active = true;
    await expect(reshare.handleProviderShareReshare('same-account-mac', [])).rejects.toThrow(/REMOTE_AGENT_INVALID/);
    expect(reshare.listProviderShareReshares()).toEqual([]);
  });

  it('drops everything a removed member reported', async () => {
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }]);
    const removed = await reshare.pruneProviderShareReshares((record) => record.memberId === 'b-member');
    expect(removed.map((record) => record.key)).toEqual([CAROL]);
    expect(reshare.listProviderShareReshares()).toEqual([]);
    expect(await reshare.decideProviderShareReshare(removed[0]!.id, 'approve')).toBeNull();
  });

  it('stages out-of-order reshare batches and replaces records only after all chunks arrive', async () => {
    const entries = manyEntries(257);
    const batchId = 'batch-a1b2c3d4e5f6';
    const first = await reshare.handleProviderShareReshare(B_GROUP, entries.slice(256), { id: batchId, index: 1, count: 2 });
    expect(first.batch).toEqual({ id: batchId, index: 1, count: 2, complete: false });
    expect(reshare.listProviderShareReshares()).toEqual([]);

    const complete = await reshare.handleProviderShareReshare(B_GROUP, entries.slice(0, 256), { id: batchId, index: 0, count: 2 });
    expect(complete.batch).toEqual({ id: batchId, index: 0, count: 2, complete: true });
    expect(complete.entries).toHaveLength(256);
    expect(reshare.listProviderShareReshares()).toHaveLength(257);
    expect(reshare.listProviderShareReshares().every((record) => record.state === 'pending')).toBe(true);

    // 已完成片段重发仍回完成状态，不会重新创建一个未完成批次。
    const duplicate = await reshare.handleProviderShareReshare(B_GROUP, entries.slice(0, 256), { id: batchId, index: 0, count: 2 });
    expect(duplicate.batch).toEqual({ id: batchId, index: 0, count: 2, complete: true });
    expect(duplicate.entries).toHaveLength(256);
    expect(reshare.listProviderShareReshares()).toHaveLength(257);
  });

  it('rejects conflicting duplicate chunks instead of replacing an earlier chunk', async () => {
    const batch = { id: 'batch-112233445566', index: 0, count: 2 } as const;
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }], batch);
    await expect(reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Changed' }], batch))
      .rejects.toThrow(/REMOTE_AGENT_INVALID/);
  });

  it('keeps the previous approvals when a reshare batch is missing a chunk', async () => {
    await reshare.handleProviderShareReshare(B_GROUP, [{ key: CAROL, name: 'Carol' }]);
    const carol = reshare.listProviderShareReshares()[0]!;
    await reshare.decideProviderShareReshare(carol.id, 'approve');
    const entries = [{ key: CAROL, name: 'Carol' }, ...manyEntries(256)];
    const result = await reshare.handleProviderShareReshare(B_GROUP, entries.slice(0, 256), {
      id: 'batch-f6e5d4c3b2a1', index: 0, count: 2,
    });
    expect(result.batch?.complete).toBe(false);
    expect(reshare.listProviderShareReshares()).toEqual([expect.objectContaining({ key: CAROL, state: 'approved' })]);
  });

  it('ignores damaged records on disk', () => {
    expect(reshare.__testing.normalize({ records: [
      { id: 'not-a-uuid', shareId: 'a', memberId: 'b', deviceId: 'c', key: CAROL, name: 'x', state: 'approved', requestedAt: 1 },
      { id: '11111111-1111-4111-8111-111111111111', shareId: 'a', memberId: 'b', deviceId: 'c', key: CAROL, name: 'Carol', state: 'maybe', requestedAt: 1 },
      { id: '22222222-2222-4222-8222-222222222222', shareId: 'a', memberId: 'b', deviceId: 'c', key: CAROL, name: 'Carol', avatar: 'http://x', state: 'approved', requestedAt: 1 },
    ] })).toEqual({ records: [{
      id: '22222222-2222-4222-8222-222222222222', shareId: 'a', memberId: 'b', deviceId: 'c', key: CAROL, name: 'Carol', avatar: null, state: 'approved', requestedAt: 1,
    }] });
  });

  it('does not silently truncate a valid record list at a fixed person count', () => {
    const records = Array.from({ length: 4097 }, (_, index) => ({
      id: index.toString(16).padStart(32, '0') + '0000',
      shareId: 'a', memberId: 'b', deviceId: 'c',
      key: index.toString(16).padStart(32, '0'),
      name: 'Person', state: 'pending', requestedAt: 1,
    }));
    expect(reshare.__testing.normalize({ records }).records).toHaveLength(4097);
  });
});
