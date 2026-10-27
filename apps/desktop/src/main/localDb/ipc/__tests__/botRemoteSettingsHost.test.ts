/**
 * 测试价值
 * - 生产入口与可观察结果:`createBotRemoteSettingsHost(...).invoke` 配合 `createBotRemoteSettingsOps`——远程桌面的伙伴设置页经
 *   `management:settings` 发来的每个操作,返回的数据/错误形状,以及调用到的服务。
 * - Bug／规则依据:cindy-bots-runtime.md「远程设置」:凭证与本机路径不出主机、提升权限仍走确认表单、隐藏/归档伙伴只在本机恢复、
 *   revision 冲突(BOT_MEMORY_CHANGED)必须让页面看得到(registry 适配层会把普通异常折叠成 INTERNAL)。
 * - 现有覆盖缺口:botRemoteSettingsResource/Editors 测的是通用表单资源,没有覆盖这条与本机页面同形的操作面。
 * - 最小失败输入:permissions 补丁;隐藏伙伴;owner 切换后才返回的结果;memory 冲突。
 * - tier:unit(进程内 fake 服务,无 DB)。
 */
import { expect, it, vi } from 'vitest';
import type { RemoteActionInvokeRequest } from '@cindy/device-link';
import { BOT_MEMORY_CHANGED } from '../../../../shared/botMemory.js';
import { BOT_SETTINGS_ACTION_ID, type BotSettingsResult } from '../../../../shared/botRemoteSettings.js';
import { createIpcError } from '../../../../shared/ipc-errors.js';
import { RemoteResourceRegistryError } from '../../../device-link/remoteResourceRegistry.js';
import { createBotRemoteSettingsHost } from '../botRemoteSettingsHost.js';
import { createBotRemoteSettingsOps, projectBotSettingsProfile, type BotSettingsOpsDeps } from '../botRemoteSettingsOps.js';

const rawProfile = {
  id: 'bot-1',
  name: 'Sora',
  homeDir: '/Users/owner/Library/bots/bot-1',
  lastMessagePreview: 'private',
  lastMessageAt: 1,
  lastMessageRole: 'assistant',
  unreadCount: 3,
  capabilities: { permissions: 'ask', memory: true },
  sessions: [
    { id: 'main', title: 'Main', kind: 'chat', role: 'canonical', updatedAt: 1, status: 'active', runtimeSnapshot: { configured: { workingDir: '/secret' } } },
    { id: 'old', title: 'Old', kind: 'history', role: 'history', updatedAt: 1, status: 'archived' },
    { id: 'lane', title: 'IM lane', kind: 'channel', role: 'channel', updatedAt: 1, status: 'active' },
    { id: 'group', title: 'Group lane', kind: 'group', role: 'group', updatedAt: 1, status: 'active' },
  ],
};

function setup(overrides: { allowed?: boolean; visible?: boolean; ownerCurrent?: () => boolean; deps?: Partial<BotSettingsOpsDeps> } = {}) {
  const deps = {
    readProfile: vi.fn(async () => rawProfile),
    updateProfile: vi.fn(async () => rawProfile),
    setAvatar: vi.fn(async () => rawProfile),
    retryInvitation: vi.fn(async () => undefined),
    lifecycle: vi.fn(async () => ({ botId: 'bot-1', action: 'restart', status: 'active', affected: {} })),
    defaultModelChain: vi.fn(async () => []),
    memory: { list: vi.fn(), read: vi.fn(), update: vi.fn(), delete: vi.fn() },
    canonicalSessionId: vi.fn(async () => 'main'),
    capabilities: vi.fn(async () => []),
    personalSkills: vi.fn(async () => []),
    autonomy: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
    searchHistory: vi.fn(async () => ({ results: [] })),
    channels: {
      im: {
        list: vi.fn(async () => ({ connections: [{ id: 'mine', botId: 'bot-1' }, { id: 'theirs', botId: 'bot-2' }] })),
        remove: vi.fn(async () => ({ connections: [{ id: 'theirs', botId: 'bot-2' }], archivedSessionIds: [] })),
        listGroups: vi.fn(async () => ({ groups: [] })), setGroupActivation: vi.fn(), listLanes: vi.fn(async () => ({ lanes: [] })),
        resetLane: vi.fn(), listAdoptable: vi.fn(async () => ({ bots: [] })), adopt: vi.fn(),
      },
      wechat: vi.fn(async () => ({
        getState: () => ({ phase: 'connected', bound: true }),
        getChannelSettings: vi.fn(() => ({ version: 1, workingDir: '/Users/owner/wechat', workingDirAvailable: true, companionBotId: 'bot-2' })),
        setCompanion: vi.fn(async () => ({ version: 1, workingDir: '/Users/owner/wechat', workingDirAvailable: true, companionBotId: 'bot-1' })),
        unbind: vi.fn(), cancelAuthorization: vi.fn(),
      })),
      x: { summary: vi.fn(() => ({ available: true, enabled: true, connected: true, companionBotId: 'bot-2' })), setCompanion: vi.fn() },
    },
    voice: { models: vi.fn(() => []), voices: vi.fn(async () => ({ voices: [] })), preference: vi.fn(async () => ({ selection: null, customized: false })), setPreference: vi.fn(async () => ({ selection: null, customized: false })) },
    routines: { list: vi.fn(async () => []), sources: vi.fn(async () => []), history: vi.fn(async () => []), save: vi.fn(async () => ({ id: 'r1' })), runNow: vi.fn(), remove: vi.fn() },
    ...overrides.deps,
  } as unknown as BotSettingsOpsDeps & { updateProfile: ReturnType<typeof vi.fn>; lifecycle: ReturnType<typeof vi.fn>; memory: Record<string, ReturnType<typeof vi.fn>>; routines: Record<string, ReturnType<typeof vi.fn>>; voice: Record<string, ReturnType<typeof vi.fn>>; channels: any };
  const host = createBotRemoteSettingsHost({
    owner: () => 'owner-1',
    isOwnerCurrent: overrides.ownerCurrent ? overrides.ownerCurrent : () => true,
    controllerAllowed: () => overrides.allowed ?? true,
    botVisible: async () => overrides.visible ?? true,
    ops: createBotRemoteSettingsOps(deps),
  });
  const call = async (op: string, args?: Record<string, unknown>, botId: string | null = 'bot-1') => {
    const request: RemoteActionInvokeRequest = {
      client: { protocolVersion: 1, primitives: [] },
      collectionId: 'teammates',
      actionId: BOT_SETTINGS_ACTION_ID,
      ...(botId ? { resourceRef: { collectionId: 'teammates', kind: 'bot', id: botId } } : {}),
      input: { v: 1, op, ...(args ? { args } : {}) },
    };
    return (await host.invoke({ controllerDeviceId: 'laptop' }, request)).result as BotSettingsResult<any>;
  };
  return { deps, call, host };
}

it('lists the implemented operations and refuses unknown ones', async () => {
  const { call } = setup();
  const caps = await call('caps', undefined, null);
  expect(caps).toMatchObject({ ok: true, value: { version: 1 } });
  expect((caps as any).value.ops).toEqual(expect.arrayContaining(['caps', 'profile.get', 'profile.update', 'memory.update', 'lifecycle.run']));
  expect(await call('shell.exec')).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  // A teammate-scoped operation without a teammate never reaches a service.
  const { deps, call: bare } = setup();
  expect(await bare('profile.get', undefined, null)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  expect(deps.readProfile).not.toHaveBeenCalled();
});

it('does not run anything for a controller that lost authorization or for a hidden teammate', async () => {
  const revoked = setup({ allowed: false });
  expect(await revoked.call('profile.update', { patch: { name: 'x' } })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  expect(revoked.deps.updateProfile).not.toHaveBeenCalled();
  const hidden = setup({ visible: false });
  expect(await hidden.call('profile.get')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  expect(hidden.deps.readProfile).not.toHaveBeenCalled();
});

it('never delivers a result produced after the account changed', async () => {
  let current = true;
  const { call } = setup({ ownerCurrent: () => current, deps: { readProfile: vi.fn(async () => { current = false; return rawProfile; }) } });
  await expect(call('profile.get')).rejects.toBeInstanceOf(RemoteResourceRegistryError);
});

it('projects the profile without the Home path, previews, runtime snapshots or hidden lanes', () => {
  const projected = projectBotSettingsProfile(rawProfile) as { sessions: Array<{ id: string }> };
  expect(projected).not.toHaveProperty('homeDir');
  expect(projected).not.toHaveProperty('lastMessagePreview');
  expect(projected).not.toHaveProperty('unreadCount');
  expect(projected.sessions.map((session) => session.id)).toEqual(['main', 'old']);
  expect(JSON.stringify(projected)).not.toContain('/secret');
});

it('writes only the fields the settings pages edit, and never a permission change', async () => {
  const { deps, call } = setup();
  const saved = await call('profile.update', { patch: { description: 'Designer', capabilities: { memory: false, mcpServers: ['a'] } } });
  expect(saved.ok).toBe(true);
  expect(deps.updateProfile).toHaveBeenCalledWith({ id: 'bot-1', description: 'Designer', capabilities: { memory: false, mcpServers: ['a'] } });
  for (const patch of [{ capabilities: { permissions: 'trusted' } }, { hidden: true }, { enabled: false }, {}, 'x']) {
    expect(await call('profile.update', { patch })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  }
  expect(deps.updateProfile).toHaveBeenCalledTimes(1);
});

it('lets the page see a memory revision conflict and hides unexpected failures', async () => {
  const conflict = setup({ deps: { memory: { update: vi.fn(async () => { throw createIpcError('PRECONDITION_FAILED', BOT_MEMORY_CHANGED); }) } as never } });
  expect(await conflict.call('memory.update', { filename: 'user_a.md', title: 't', body: 'b', expectedUpdatedAt: '2026-01-01T00:00:00Z' }))
    .toEqual({ ok: false, code: 'PRECONDITION_FAILED', message: BOT_MEMORY_CHANGED });
  const broken = setup({ deps: { readProfile: vi.fn(async () => { throw new Error('/Users/owner/secret.db is locked'); }) } });
  await expect(broken.call('profile.get')).rejects.toMatchObject({ code: 'INTERNAL', message: 'Settings operation failed' });
});

it('restricts lifecycle operations to the ones the settings page offers', async () => {
  const { deps, call } = setup();
  expect(await call('lifecycle.run', { action: 'pause' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  expect(await call('lifecycle.run', { action: 'delete', confirmName: 'Sora', keepTaskHistory: true, worktreeDisposition: 'retain' })).toMatchObject({ ok: true });
  expect(deps.lifecycle).toHaveBeenCalledWith(
    { botId: 'bot-1', action: 'delete', confirmName: 'Sora', worktreeDisposition: 'retain', keepTaskHistory: true },
    expect.any(Function),
  );
});

it('validates a routine before it reaches the shared routine service and reports one generic failure', async () => {
  const { deps, call } = setup();
  const invalid = await call('routines.save', { input: { name: '', prompt: '' } });
  expect(invalid).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  expect(deps.routines.save).not.toHaveBeenCalled();
  const saved = await call('routines.save', { id: 'r1', input: { name: 'Digest', prompt: 'Summarise', enabled: true, triggers: [{ id: 't1', kind: 'interval', intervalMs: 3_600_000 }] } });
  expect(saved).toMatchObject({ ok: true, value: { id: 'r1' } });
  expect(deps.routines.save).toHaveBeenCalledWith('bot-1', expect.objectContaining({ name: 'Digest' }), 'r1');
  // Event sources are host-wide: no teammate is required.
  expect(await call('routines.sources', undefined, null)).toMatchObject({ ok: true });
});

it('keeps "not provided" and "reset to default" apart when a voice preference is written', async () => {
  const { deps, call } = setup();
  await call('voice.setPreference', { sentencePlayback: false });
  expect(deps.voice.setPreference).toHaveBeenLastCalledWith('bot-1', undefined, false);
  await call('voice.setPreference', { selection: null, sentencePlayback: null });
  expect(deps.voice.setPreference).toHaveBeenLastCalledWith('bot-1', null, null);
  // The catalog is host-wide; a failing voice service never leaks its message.
  (deps.voice.models as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('key sk-secret rejected'); });
  expect(await call('voice.models', undefined, null)).toEqual({ ok: false, code: 'PRECONDITION_FAILED', message: 'Voice conversation is unavailable.' });
});

it('limits messaging-platform operations to this teammate and keeps the WeChat folder path home', async () => {
  const { deps, call } = setup();
  // Another teammate's connection can be neither removed nor inspected from this teammate's page.
  expect(await call('channels.im.remove', { id: 'theirs' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  expect(await call('channels.im.listGroups', { id: 'theirs' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  expect(deps.channels.im.remove).not.toHaveBeenCalled();
  // Results list only this teammate's connections.
  expect(await call('channels.im.remove', { id: 'mine' })).toMatchObject({ ok: true, value: { connections: [] } });
  expect(await call('channels.im.list')).toMatchObject({ ok: true, value: { connections: [{ id: 'mine' }] } });
  // WeChat is assigned to someone else: this page can neither release nor unbind it, and never sees the folder path.
  expect(await call('channels.wechat.setCompanion', { assign: false })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  expect(await call('channels.wechat.unbind')).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  const wechat = await call('channels.wechat.get');
  expect(wechat).toMatchObject({ ok: true, value: { channelSettings: { companionBotId: 'bot-2', workingDir: null } } });
  // The official X account behaves the same way.
  expect(await call('channels.x.setCompanion', { assign: false, expectedBotId: 'bot-2' })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  expect(deps.channels.x.setCompanion).not.toHaveBeenCalled();
  // There is no operation that takes credentials.
  expect(await call('channels.im.add', { token: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
});

it('holds the teammate a host-wide autonomy change names to the same visibility as a teammate-scoped call', async () => {
  const hidden = setup({ visible: false });
  expect(await hidden.call('autonomy.set', { schedulerBotId: 'bot-2' }, null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  expect(hidden.deps.autonomy.set).not.toHaveBeenCalled();
  // Turning it off names nobody.
  expect(await hidden.call('autonomy.set', { schedulerBotId: null }, null)).toMatchObject({ ok: true });
  expect(hidden.deps.autonomy.set).toHaveBeenCalledWith(null);
  const visible = setup();
  expect(await visible.call('autonomy.set', { schedulerBotId: 'bot-2' }, null)).toMatchObject({ ok: true });
  expect(visible.deps.autonomy.set).toHaveBeenCalledWith('bot-2');
});
