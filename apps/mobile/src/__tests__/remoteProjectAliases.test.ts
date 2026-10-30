// Unit regression: the mobile mirror must reject prior-account/connection replies while retaining current project names.
// Existing generic mirror tests lack mobile owner stamps/topic ownership. Minimal failure: one pending read,
// then account switch, peer suspend or last sessions-owner release before that read resolves.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptRemoteProjectAliasesChanged,
  refreshRemoteProjectAliases,
  remoteProjectAliasesSnapshot,
  removeRemoteProjectAliases,
  setRemoteProjectAliasesAccount,
  suspendRemoteProjectAliases,
  suspendRemoteProjectAliasesForReleasedTopics,
} from '@/session/remoteProjectAliases';
import { DeviceLinkTopicRegistry } from '@/device-link/topicRegistry';

let generation = 0;
const snapshot = (alias: string, owner = 'user-a', ownerGeneration = 1) => ({
  aliases: [{ projectKey: 'local:/repo/app', alias }],
  platform: 'darwin',
  ownerStamp: { dataOwnerId: owner, ownerGeneration },
});

describe('mobile project alias ownership', () => {
  beforeEach(() => setRemoteProjectAliasesAccount('user-a', ++generation));

  it('discards an account-switched response and clears the previous account before the next read', async () => {
    await refreshRemoteProjectAliases('desktop', async () => snapshot('旧账号'));
    let finish!: (value: unknown) => void;
    const pending = refreshRemoteProjectAliases('desktop', () => new Promise((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    setRemoteProjectAliasesAccount('user-b', ++generation);
    expect(remoteProjectAliasesSnapshot().size).toBe(0);
    finish(snapshot('迟到旧账号'));
    await pending;
    expect(remoteProjectAliasesSnapshot().size).toBe(0);
    await refreshRemoteProjectAliases('desktop', async () => snapshot('新账号', 'user-b'));
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('新账号');
  });

  it('accepts only current-account, nonobsolete notifications and snapshots', async () => {
    expect(acceptRemoteProjectAliasesChanged('desktop', undefined)).toBe(false);
    expect(acceptRemoteProjectAliasesChanged('desktop', { dataOwnerId: 'user-b', ownerGeneration: 2 })).toBe(false);
    expect(acceptRemoteProjectAliasesChanged('desktop', { dataOwnerId: 'user-a', ownerGeneration: 3 })).toBe(true);
    expect(acceptRemoteProjectAliasesChanged('desktop', { dataOwnerId: 'user-a', ownerGeneration: 2 })).toBe(false);
    await refreshRemoteProjectAliases('desktop', async () => ({
      aliases: [{ projectKey: 'local:/repo/app', alias: '缺少归属' }],
      platform: 'darwin',
    }));
    expect(remoteProjectAliasesSnapshot().has('desktop')).toBe(false);
    await refreshRemoteProjectAliases('desktop', async () => snapshot('其他账号', 'user-b', 3));
    expect(remoteProjectAliasesSnapshot().has('desktop')).toBe(false);
    await refreshRemoteProjectAliases('desktop', async () => snapshot('旧代', 'user-a', 2));
    expect(remoteProjectAliasesSnapshot().has('desktop')).toBe(false);
    await refreshRemoteProjectAliases('desktop', async () => snapshot('当前代', 'user-a', 3));
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('当前代');
  });

  // A rejected stale read retains the old visible mirror; it must not lower the newer push watermark.
  it('keeps a newer notification watermark after rejecting an older read over an existing mirror', async () => {
    await refreshRemoteProjectAliases('desktop', async () => snapshot('已知名称', 'user-a', 1));
    expect(acceptRemoteProjectAliasesChanged('desktop', snapshot('新通知', 'user-a', 3).ownerStamp)).toBe(true);
    await refreshRemoteProjectAliases('desktop', async () => snapshot('迟到读取', 'user-a', 2));
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('已知名称');
    expect(acceptRemoteProjectAliasesChanged('desktop', snapshot('旧通知', 'user-a', 2).ownerStamp)).toBe(false);
    await refreshRemoteProjectAliases('desktop', async () => snapshot('旧代重试', 'user-a', 2));
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('已知名称');
  });

  it('retains names during a disconnect, rejects late reads, and permits a restarted host generation', async () => {
    await refreshRemoteProjectAliases('desktop', async () => snapshot('已知名称', 'user-a', 5));
    let finish!: (value: unknown) => void;
    const pending = refreshRemoteProjectAliases('desktop', () => new Promise((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    suspendRemoteProjectAliases('desktop');
    expect(acceptRemoteProjectAliasesChanged('desktop', snapshot('迟到通知', 'user-a', 5).ownerStamp, () => false)).toBe(false);
    finish(snapshot('迟到', 'user-a', 5));
    await pending;
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('已知名称');
    await refreshRemoteProjectAliases('desktop', async () => snapshot('重启后名称', 'user-a', 1));
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('重启后名称');
  });

  // Reconnect can fail once before a restarted host responds with a lower generation.
  // A retained display snapshot must not restore the suspended connection's owner watermark.
  it('accepts a restarted host after the first reconnect read fails while retaining its old display name', async () => {
    await refreshRemoteProjectAliases('desktop', async () => snapshot('重启前名称', 'user-a', 8));
    suspendRemoteProjectAliases('desktop');
    await refreshRemoteProjectAliases('desktop', async () => { throw new Error('temporary network failure'); });
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('重启前名称');
    await refreshRemoteProjectAliases('desktop', async () => snapshot('重启后名称', 'user-a', 1));
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('重启后名称');
  });

  it('does not start metadata reads outside an active subscription and removes revoked device data only', async () => {
    const read = vi.fn(async () => snapshot('当前项目'));
    await refreshRemoteProjectAliases('desktop-a', read, () => false);
    expect(read).not.toHaveBeenCalled();
    await refreshRemoteProjectAliases('desktop-a', read);
    await refreshRemoteProjectAliases('desktop-b', read);
    removeRemoteProjectAliases('desktop-a');
    expect([...remoteProjectAliasesSnapshot().keys()]).toEqual(['desktop-b']);
  });

  it('keeps other owners reads alive and starts a fresh read after the last owner leaves and reenters', async () => {
    const registry = new DeviceLinkTopicRegistry();
    registry.trackSubscribe('home', 'desktop', ['sessions']);
    registry.trackSubscribe('drawer', 'desktop', ['sessions']);
    const isCurrent = () => registry.hasTopic('desktop', 'sessions');
    let finish!: (value: unknown) => void;
    const pending = refreshRemoteProjectAliases('desktop', () => new Promise((resolve) => { finish = resolve; }), isCurrent);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    suspendRemoteProjectAliasesForReleasedTopics('desktop', registry.untrackSubscribe('drawer', 'desktop', ['sessions']));
    finish(snapshot('仍被首页订阅'));
    await pending;
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('仍被首页订阅');

    let finishOldRead!: (value: unknown) => void;
    const oldRead = refreshRemoteProjectAliases('desktop', () => new Promise((resolve) => { finishOldRead = resolve; }), isCurrent);
    await vi.waitFor(() => expect(finishOldRead).toBeTypeOf('function'));
    suspendRemoteProjectAliasesForReleasedTopics('desktop', registry.untrackSubscribe('home', 'desktop', ['sessions']));
    registry.trackSubscribe('home', 'desktop', ['sessions']);
    const newRead = vi.fn(async () => snapshot('重新进入后的名称'));
    await refreshRemoteProjectAliases('desktop', newRead, isCurrent);
    expect(newRead).toHaveBeenCalledOnce();
    finishOldRead(snapshot('离开前迟到的旧名称'));
    await oldRead;
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('重新进入后的名称');
  });

  it('starts a fresh foreground read even when background suspension interrupted the first snapshot', async () => {
    let finish!: (value: unknown) => void;
    const backgroundRead = refreshRemoteProjectAliases('desktop', () => new Promise((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    suspendRemoteProjectAliases();
    await refreshRemoteProjectAliases('desktop', async () => snapshot('回前台后的名称'));
    finish(snapshot('后台迟到名称'));
    await backgroundRead;
    expect(remoteProjectAliasesSnapshot().get('desktop')?.aliases[0].alias).toBe('回前台后的名称');
  });
});
