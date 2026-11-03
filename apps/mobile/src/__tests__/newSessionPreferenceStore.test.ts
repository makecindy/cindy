import { captureNewSessionOwner } from '@/session/newSessionForm';
import { accountVaultKey } from '@cindy/auth-client';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

describe('newSessionPreferenceStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store.clear();
    const { clearNewSessionPreferences } = await import('@/session/newSessionPreferenceStore');
    await clearNewSessionPreferences();
    store.clear();
    setMobileAuthOwner('account-a');
  });

  it('isolates directories on the same device across accounts and signed-out reads', async () => {
    const { readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'shared-device', workingDir: '/account-a/private' } });
    setMobileAuthOwner('account-b');
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({});
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'shared-device', workingDir: '/account-b/private' } });
    setMobileAuthOwner(null);
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({});
    setMobileAuthOwner('account-a');
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({ 'shared-device': '/account-a/private' });
    setMobileAuthOwner('account-b');
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({ 'shared-device': '/account-b/private' });
  });

  it('does not adopt the unowned legacy directory map into a logged-in account', async () => {
    const { __testing, readNewSessionPreferences } = await import('@/session/newSessionPreferenceStore');
    store.set(__testing.storageKey, JSON.stringify({ agentKind: 'codex', workingDirByDevice: { devA: '/previous-owner/private' } }));
    expect(await readNewSessionPreferences()).toMatchObject({ agentKind: 'codex', workingDirByDevice: {} });
  });

  it('does not attribute a queued directory save or late read to the next account', async () => {
    const { readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    const saving = saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'shared-device', workingDir: '/account-a/private' } });
    const reading = readNewSessionPreferences();
    setMobileAuthOwner('account-b');
    await saving;
    expect((await reading).workingDirByDevice).toEqual({});
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({});
  });

  it('isolates equal membership IDs across realms and invalidates pending work', async () => {
    const { __testing, readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    store.set(__testing.workingDirStorageKey('shared-member'), JSON.stringify({
      'shared-device': '/unqualified/private',
    }));
    setMobileAuthOwner('shared-member', 'cn');
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({});
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'shared-device', workingDir: '/cn/private' } });
    const cnOwner = getMobileAuthOwner();
    const saving = saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'shared-device', workingDir: '/cn/pending' } });
    const reading = readNewSessionPreferences();
    setMobileAuthOwner('shared-member', 'global');
    expect(isMobileAuthOwnerCurrent(cnOwner)).toBe(false);
    await saving;
    expect((await reading).workingDirByDevice).toEqual({});
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({});
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'shared-device', workingDir: '/global/private' } });
    setMobileAuthOwner('shared-member', 'cn');
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({ 'shared-device': '/cn/private' });
    setMobileAuthOwner('shared-member', 'global');
    expect((await readNewSessionPreferences()).workingDirByDevice).toEqual({ 'shared-device': '/global/private' });
  });

  it('keeps the bare owner ID accepted by both live creation guards and recovery namespaces', () => {
    setMobileAuthOwner('shared-member', 'cn');
    const currentOwner = getMobileAuthOwner();
    const creation = captureNewSessionOwner(currentOwner, 'shared-member');
    expect(creation.isCurrentOwner()).toBe(true);
    expect(creation.worktreeAccountId).toBe('shared-member');
    setMobileAuthOwner('shared-member', 'global');
    expect(creation.isCurrentOwner()).toBe(false);
    expect(captureNewSessionOwner(getMobileAuthOwner(), 'another-member').isCurrentOwner()).toBe(false);
  });

  it('stores the last selected device and agent for new sessions', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    await saveNewSessionPreferences({
      device: { deviceId: 'devA', name: 'Mac A' },
    });
    await saveNewSessionPreferences({ agentKind: 'codex' });

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: 'codex',
      device: { deviceId: 'devA', name: 'Mac A' },
      workspaceKind: null,
      permissionModeByAgent: {},
      workingDirByDevice: {},
      remoteAgentByDevice: {},
    });
    expect(JSON.parse(store.get(__testing.storageKey) ?? '{}')).toEqual({
      agentKind: 'codex',
      deviceId: 'devA',
      deviceName: 'Mac A',
    });
  });

  it('normalizes invalid or stale persisted data without blocking the page', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    store.set(__testing.storageKey, JSON.stringify({
      agentKind: 'unknown',
      deviceId: '  devB  ',
      deviceName: '',
    }));

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: { deviceId: 'devB', name: 'devB' },
      workspaceKind: null,
      permissionModeByAgent: {},
      workingDirByDevice: {},
      remoteAgentByDevice: {},
    });

    store.set(__testing.storageKey, '{broken');
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      workspaceKind: null,
      permissionModeByAgent: {},
      workingDirByDevice: {},
      remoteAgentByDevice: {},
    });

    await saveNewSessionPreferences({
      device: { deviceId: '  devC  ', name: '  ' },
    });
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: { deviceId: 'devC', name: 'devC' },
      workspaceKind: null,
      permissionModeByAgent: {},
      workingDirByDevice: {},
      remoteAgentByDevice: {},
    });
  });

  it('remembers per-agent permission modes and drops plan / stale entries', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    await saveNewSessionPreferences({
      permissionModeForAgent: { agentKind: 'claude-code', mode: 'bypassPermissions' },
    });
    await saveNewSessionPreferences({
      permissionModeForAgent: { agentKind: 'codex', mode: 'ask' },
    });
    // plan 是计划模式实现细节,不入记忆(忽略而非报错)。
    await saveNewSessionPreferences({
      permissionModeForAgent: { agentKind: 'claude-code', mode: 'plan' },
    });

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      workspaceKind: null,
      permissionModeByAgent: { 'claude-code': 'bypassPermissions', codex: 'ask' },
      workingDirByDevice: {},
      remoteAgentByDevice: {},
    });

    // 落盘的 plan / 非法 agent 键在读取时被清洗。
    store.set(__testing.storageKey, JSON.stringify({
      permissionModeByAgent: { 'claude-code': 'plan', codex: 'auto', other: 'ask' },
    }));
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      workspaceKind: null,
      permissionModeByAgent: { codex: 'auto' },
      workingDirByDevice: {},
      remoteAgentByDevice: {},
    });
  });

  it('remembers the last explicitly chosen project directory per device (#4103)', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'devA', workingDir: '/repo/third' } });
    // 路径原样保存:首尾空格可能是目录名的一部分(review:Greptile P1)
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'devB', workingDir: ' /other/app ' } });
    // 同设备再次选择覆盖上次;空值 / 空设备被忽略,不清掉已有记忆。
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'devA', workingDir: '/repo/fourth' } });
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: 'devA', workingDir: '   ' } });
    await saveNewSessionPreferences({ workingDirForDevice: { deviceId: '', workingDir: '/nope' } });
    await saveNewSessionPreferences({ workspaceKind: 'dialogue' });

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      workspaceKind: 'dialogue',
      permissionModeByAgent: {},
      workingDirByDevice: { devA: '/repo/fourth', devB: ' /other/app ' },
      remoteAgentByDevice: {},
    });
    expect(JSON.parse(store.get(__testing.storageKey) ?? '{}')).toEqual({
      workspaceKind: 'dialogue',
    });
    expect(JSON.parse(store.get(__testing.workingDirStorageKey(accountVaultKey('global', 'account-a'))) ?? '{}')).toEqual({ devA: '/repo/fourth', devB: ' /other/app ' });

    // 落盘里的非法条目(非字符串 / 空)在读取时被清洗,旧存储没有该字段也不报错。
    store.set(__testing.workingDirStorageKey(accountVaultKey('global', 'account-a')), JSON.stringify({ devA: '/repo/ok', devB: 42, ' ': '/x', devC: '', devD: ' /keep me ' }));
    await expect(readNewSessionPreferences()).resolves.toMatchObject({
      workingDirByDevice: { devA: '/repo/ok', devD: ' /keep me ' },
      remoteAgentByDevice: {},
    });
    store.set(__testing.workingDirStorageKey(accountVaultKey('global', 'account-a')), JSON.stringify('bad'));
    await expect(readNewSessionPreferences()).resolves.toMatchObject({ workingDirByDevice: {} });
  });

  // 回归:新建页选了其他电脑 / 分享来的模型，下次打开就回到被控电脑默认。按(账号, 被控电脑, agent)记,
  // 选回被控电脑自己的模型即清掉。
  it('remembers the remote or shared model per controlled device and agent, per account', async () => {
    const { readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    const pick = { deviceId: 'share:s1', agentKind: 'codex' as const, model: 'gpt-x', providerId: 'openai', effort: 'high', fastMode: true };
    await saveNewSessionPreferences({ remoteAgentForDevice: { deviceId: 'mac', agentKind: 'codex', pick } });
    await saveNewSessionPreferences({ remoteAgentForDevice: { deviceId: 'mac', agentKind: 'pi', pick: { ...pick, agentKind: 'pi', deviceId: 'studio' } } });
    expect((await readNewSessionPreferences()).remoteAgentByDevice).toEqual({
      mac: { codex: pick, pi: { ...pick, agentKind: 'pi', deviceId: 'studio' } },
    });
    setMobileAuthOwner('account-b');
    expect((await readNewSessionPreferences()).remoteAgentByDevice).toEqual({});
    setMobileAuthOwner('account-a');
    await saveNewSessionPreferences({ remoteAgentForDevice: { deviceId: 'mac', agentKind: 'codex', pick: null } });
    await saveNewSessionPreferences({ remoteAgentForDevice: { deviceId: 'mac', agentKind: 'pi', pick: null } });
    expect((await readNewSessionPreferences()).remoteAgentByDevice).toEqual({});
  });

  it('remembers either workspace mode across reloads without losing other preferences', async () => {
    const { readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');

    await Promise.all([
      saveNewSessionPreferences({ workspaceKind: 'project' }),
      saveNewSessionPreferences({ device: { deviceId: 'devA', name: 'Mac A' } }),
      saveNewSessionPreferences({ agentKind: 'codex' }),
    ]);
    expect(await readNewSessionPreferences()).toMatchObject({
      workspaceKind: 'project',
      device: { deviceId: 'devA', name: 'Mac A' },
      agentKind: 'codex',
    });

    await Promise.all([
      saveNewSessionPreferences({ workspaceKind: 'project' }),
      saveNewSessionPreferences({ workspaceKind: 'dialogue' }),
      saveNewSessionPreferences({ permissionModeForAgent: { agentKind: 'codex', mode: 'ask' } }),
    ]);
    expect(await readNewSessionPreferences()).toMatchObject({
      workspaceKind: 'dialogue',
      agentKind: 'codex',
      permissionModeByAgent: { codex: 'ask' },
      workingDirByDevice: {},
    });
  });

  it('ignores an unknown workspace mode in old or invalid storage', async () => {
    const { __testing, readNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    store.set(__testing.storageKey, JSON.stringify({ workspaceKind: 'unknown', agentKind: 'codex' }));
    expect(await readNewSessionPreferences()).toMatchObject({ workspaceKind: null, agentKind: 'codex' });
  });

  it('restores the latest choice when the page reopens before saving finishes', async () => {
    const { readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    const saving = saveNewSessionPreferences({ workspaceKind: 'project' });
    const reopened = readNewSessionPreferences();
    expect(await reopened).toMatchObject({ workspaceKind: 'project' });
    await saving;
  });

  it('clears pending selections without letting them restore cleared preferences', async () => {
    const { clearNewSessionPreferences, readNewSessionPreferences, saveNewSessionPreferences } =
      await import('@/session/newSessionPreferenceStore');
    await Promise.all([
      saveNewSessionPreferences({ workspaceKind: 'project' }),
      clearNewSessionPreferences(),
    ]);
    expect(await readNewSessionPreferences()).toMatchObject({ workspaceKind: null });
    expect(store.size).toBe(0);
  });
});
