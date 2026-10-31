/**
 * 测试价值
 * - 生产入口与可观察结果:`createRemoteBotSettingsTarget`——远程伙伴设置页调用的 profile/memory/capabilities/lifecycle 接口,
 *   以及它们经 `management:settings` 发给伙伴所在电脑的请求与页面看到的结果/错误。
 * - Bug／规则依据:cindy-bots-runtime.md「远程设置」:本机页与远程页同一套组件,自动保存的乐观写入/回滚语义一致;记忆 revision
 *   冲突必须以本机同样的错误形状到达页面;旧主机缺的操作不得出现对应页面。
 * - 现有覆盖缺口:remoteBotSettings.test.tsx 测通用表单页;没有覆盖这条与本机页同形的目标实现。
 * - 最小失败输入:主机拒绝写入;写入在途时的旧读取;超长文本补丁;memory 冲突;只有 profile 操作的旧主机。
 * - tier:unit(假的 deviceLink.invoke,无 DOM)。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BOT_MEMORY_CHANGED } from '../../../../shared/botMemory';
import type { BotSettingsOp } from '../../../../shared/botRemoteSettings';
import { extractIpcError } from '../../../utils/ipcError';

const host = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/hooks/useAvailableAgents', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/hooks/useAvailableAgents')>()), useAvailableAgents: () => ({ availableVendors: new Set(), loaded: false }) }));

import { createRemoteBotSettingsTarget, remoteBotSettingsPages } from '../remoteBotSettingsTarget';

const profile = (patch: Record<string, unknown> = {}) => ({
  id: 'bot-1', name: 'Sora', description: '', identitySource: 'old soul', userContextSource: '', avatar: '🙂', avatarColor: 'teal',
  status: 'active', skills: [], currentVersion: 1, createdAt: 1, sessions: [],
  capabilities: { harness: 'pi', model: 'm', modelChain: [{ harness: 'pi', model: 'm', providerId: null, effort: '', fastMode: false }], memory: true, permissions: 'ask' },
  ...patch,
});
const ok = (value: unknown) => ({ result: { ok: true, value }, effects: [] });
const refused = (code: string, message: string) => ({ result: { ok: false, code, message }, effects: [] });
/** The request a page produced, as the host receives it. */
const sent = (call = 0) => host.invoke.mock.calls[call][2][0] as { input: { op: BotSettingsOp; args?: Record<string, unknown> }; resourceRef?: { id: string } };
const ALL_OPS = ['caps', 'profile.get', 'profile.update', 'profile.chooseAvatar', 'profile.retryInvitation', 'lifecycle.run', 'models.default',
  'memory.list', 'memory.read', 'memory.update', 'memory.delete', 'capabilities.catalog', 'autonomy.get', 'autonomy.set', 'autonomy.reset', 'history.search',
  'routines.list', 'routines.sources', 'routines.history', 'routines.save', 'routines.runNow', 'routines.remove',
  'voice.models', 'voice.voices', 'voice.preference', 'voice.setPreference',
  'channels.im.list', 'channels.im.remove', 'channels.wechat.get', 'channels.x.get'] as BotSettingsOp[];

function create(ops: BotSettingsOp[] = ALL_OPS) {
  return createRemoteBotSettingsTarget({ deviceId: 'mac', deviceName: 'Studio', botId: 'bot-1', ops: new Set(ops), online: () => true });
}

beforeEach(() => {
  host.invoke.mockReset();
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke: host.invoke } } });
});
afterEach(() => vi.unstubAllGlobals());

it('applies the host profile after an autosave and sends only what changed', async () => {
  const { target, profiles } = create();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile() }));
  await profiles.load();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile({ description: 'Designer', avatar: '🙂' }) }));
  const next = await target.profile.update('bot-1', { description: 'Designer', capabilities: { memory: false } });
  expect(sent(1)).toMatchObject({ resourceRef: { id: 'bot-1' }, input: { op: 'profile.update', args: { patch: { description: 'Designer', capabilities: { memory: false } } } } });
  expect(next.description).toBe('Designer');
  expect(profiles.get()?.description).toBe('Designer');
});

it('rolls an optimistic write back and rejects with the host error when the host refuses it', async () => {
  const { target, profiles } = create();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile() }));
  await profiles.load();
  host.invoke.mockResolvedValueOnce(refused('INVALID_PARAMS', 'Model route unavailable'));
  const write = target.profile.update('bot-1', { name: 'Renamed' });
  expect(profiles.get()?.name).toBe('Renamed');
  await expect(write).rejects.toSatisfy((error) => extractIpcError(error)?.code === 'INVALID_PARAMS');
  expect(profiles.get()?.name).toBe('Sora');
});

it('ignores a read that was overtaken by a write', async () => {
  const { target, profiles } = create();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile() }));
  await profiles.load();
  let release!: (value: unknown) => void;
  host.invoke.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  const stale = profiles.refresh();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile({ name: 'Renamed' }) }));
  await target.profile.update('bot-1', { name: 'Renamed' });
  release(ok({ profile: profile() }));
  await stale;
  expect(profiles.get()?.name).toBe('Renamed');
});

it('sends long personality and user text as separate requests so none exceeds the invoke input limit', async () => {
  const { target, profiles } = create();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile() }));
  await profiles.load();
  host.invoke.mockResolvedValue(ok({ profile: profile() }));
  const long = '字'.repeat(12_000); // 36 KB in UTF-8
  await target.profile.update('bot-1', { identitySource: long, userContextSource: long, avatarColor: 'blue' });
  const patches = host.invoke.mock.calls.slice(1).map((call) => Object.keys((call[2][0] as { input: { args: { patch: object } } }).input.args.patch));
  expect(patches).toEqual([['avatarColor'], ['identitySource'], ['userContextSource']]);
});

it('hands the memory page the same conflict error the local call raises', async () => {
  const { target } = create();
  host.invoke.mockResolvedValueOnce(refused('PRECONDITION_FAILED', BOT_MEMORY_CHANGED));
  const error = await target.memory.update({ botId: 'bot-1', filename: 'user_a.md', title: 't', body: 'b', expectedUpdatedAt: 'x' }).catch((e) => e);
  expect(extractIpcError(error)).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(extractIpcError(error)?.message).toContain(BOT_MEMORY_CHANGED);
  expect(sent()).toMatchObject({ resourceRef: { id: 'bot-1' }, input: { op: 'memory.update', args: { filename: 'user_a.md', expectedUpdatedAt: 'x' } } });
});

it('builds the capability lists from the host catalog without the fixed baseline toolsets', async () => {
  const { target } = create();
  host.invoke.mockResolvedValueOnce(ok({
    personal: [{ slug: 'brief', name: 'Brief', description: '', updatedAt: '', enabled: false }],
    entries: {
      skill: [{ id: 'review', name: 'review', description: 'Review', available: true, joined: true }],
      mcp: [{ id: 'm1', name: 'Docs', description: 'http', available: false, joined: false }],
      toolset: [{ id: 'memory', name: 'Memory', description: '', available: true, joined: true }, { id: 'browser', name: 'Browser', description: '', available: true, joined: false }],
    },
  }));
  const catalog = await target.capabilities.load({ id: 'bot-1' } as never, [], () => true);
  expect(catalog.skill).toEqual([
    { id: 'personal:brief', name: 'Brief', available: false, personal: true },
    { id: 'review', name: 'review', description: 'Review', available: true },
  ]);
  expect(catalog.mcp).toEqual([{ id: 'm1', name: 'Docs', description: 'http', available: false }]);
  expect(catalog.toolset?.map((item) => item.id)).toEqual(['browser']);
});

it('does not re-read a deleted teammate after the lifecycle action', async () => {
  const { target } = create();
  host.invoke.mockResolvedValueOnce(ok({ botId: 'bot-1', action: 'delete', status: 'deleted', affected: {} }));
  await target.lifecycle.run({ botId: 'bot-1', action: 'delete', confirmName: 'Sora' });
  expect(host.invoke).toHaveBeenCalledTimes(1);
});

it('offers routine session modes only to hosts that keep them', async () => {
  // A host that predates session modes accepts saveWithModel but drops sessionMode.
  const older = create([...ALL_OPS, 'routines.saveWithModel']);
  expect(older.target.routineSessionModes).toBe(false);
  host.invoke.mockResolvedValue(ok([]));
  await older.target.routines.save('bot-1', { name: 'Digest' } as never, 'r1');
  expect(sent()).toMatchObject({ input: { op: 'routines.saveWithModel' } });
  const current = create([...ALL_OPS, 'routines.saveWithModel', 'routines.saveWithSessionMode']);
  expect(current.target.routineSessionModes).toBe(true);
  await current.target.routines.save('bot-1', { name: 'Digest', sessionMode: 'fresh' } as never, 'r1');
  expect(sent(1)).toMatchObject({ input: { op: 'routines.saveWithSessionMode', args: { input: { sessionMode: 'fresh' } } } });
});

it('runs routines on the teammate computer and tells the page when they change there', async () => {
  const { target, changed } = create();
  host.invoke.mockResolvedValue(ok([]));
  await target.routines.save('bot-1', { name: 'Digest' } as never, 'r1');
  expect(sent()).toMatchObject({ resourceRef: { id: 'bot-1' }, input: { op: 'routines.save', args: { id: 'r1', input: { name: 'Digest' } } } });
  await target.routines.sources();
  expect(sent(1)).toMatchObject({ input: { op: 'routines.sources' } });
  expect(sent(1).resourceRef).toBeUndefined();
  const listener = vi.fn();
  const off = target.routines.onChanged(listener);
  changed('routines');
  expect(listener).toHaveBeenCalledTimes(1);
  off();
  changed('routines');
  expect(listener).toHaveBeenCalledTimes(1);
});

it('never takes credentials and leaves browser sign-in and folder choosing to the teammate computer', async () => {
  const { target } = create();
  const im = target.channels.im!;
  expect(target.channels.canEnterCredentials).toBe(false);
  await expect(im.add({ botId: 'bot-1', channel: 'telegram', token: 'secret', ownerUserId: '1' })).rejects.toSatisfy((error) => extractIpcError(error)?.code === 'PRECONDITION_FAILED');
  await expect(target.channels.wechat!.authorize()).rejects.toBeTruthy();
  await expect(target.channels.wechat!.chooseWorkingDirectory()).rejects.toBeTruthy();
  expect(host.invoke).not.toHaveBeenCalled();
  host.invoke.mockResolvedValueOnce(ok({ channelSettings: { version: 1, workingDir: null, workingDirAvailable: true, companionBotId: 'bot-1' } }));
  await expect(target.channels.wechat!.setCompanion('bot-1')).resolves.toMatchObject({ companionBotId: 'bot-1' });
  expect(sent()).toMatchObject({ resourceRef: { id: 'bot-1' }, input: { op: 'channels.wechat.setCompanion', args: { assign: true } } });
});

it('offers only the pages whose operations the host implements', () => {
  expect([...remoteBotSettingsPages(new Set(ALL_OPS))].sort()).toEqual(['capabilities', 'channels', 'history', 'memory', 'model', 'personality', 'profile', 'routines', 'voice']);
  expect([...remoteBotSettingsPages(new Set<BotSettingsOp>(['caps', 'profile.get', 'profile.update']))].sort()).toEqual(['personality', 'profile']);
  // The Home folder is a path on the teammate's computer: no remote host ever offers it.
  expect(remoteBotSettingsPages(new Set(ALL_OPS)).has('advanced')).toBe(false);
});

it('starts again from the host profile, not from the old one, when a later part of a split patch fails after an earlier one was saved', async () => {
  const { target, profiles } = create();
  host.invoke.mockResolvedValueOnce(ok({ profile: profile() }));
  await profiles.load();
  const long = '字'.repeat(12_000);
  host.invoke
    .mockResolvedValueOnce(ok({ profile: profile({ avatarColor: 'blue' }) }))
    .mockResolvedValueOnce(ok({ profile: profile({ avatarColor: 'blue', identitySource: long }) }))
    .mockResolvedValueOnce(refused('INTERNAL', 'Computer went away'))
    // The re-read after the failure: the first two parts are on the computer.
    .mockResolvedValueOnce(ok({ profile: profile({ avatarColor: 'blue', identitySource: long }) }));
  await expect(target.profile.update('bot-1', { identitySource: long, userContextSource: long, avatarColor: 'blue' }))
    .rejects.toSatisfy((error) => extractIpcError(error)?.code === 'INTERNAL');
  expect(sent(4)).toMatchObject({ input: { op: 'profile.get' } });
  expect(profiles.get()).toMatchObject({ avatarColor: 'blue', identitySource: long, userContextSource: '' });
});

it('negotiates final delivery and discovers recipients on the teammate computer', async () => {
  const older = create();
  expect(older.target.routineDelivery).toBe(false);
  expect(await older.target.routines.deliveryTargets?.('bot-1')).toEqual([]);
  const current = create([...ALL_OPS, 'routines.saveWithDelivery', 'routines.deliveryTargets']);
  host.invoke.mockResolvedValue(ok([]));
  const delivery = { kind: 'im', targetId: 'host-destination' };
  await current.target.routines.save('bot-1', { name: 'Digest', delivery } as never, 'r1');
  expect(sent()).toMatchObject({ resourceRef: { id: 'bot-1' }, input: { op: 'routines.saveWithDelivery', args: { input: { delivery } } } });
  await current.target.routines.deliveryTargets?.('bot-1');
  expect(sent(1)).toMatchObject({ resourceRef: { id: 'bot-1' }, input: { op: 'routines.deliveryTargets' } });
});

// New host capability is optional; old hosts must never show a selector that cannot execute.
it('reads media models from the teammate computer only when the host advertises support', async () => {
  expect(create().target.mediaModels).toBeUndefined();
  const { target } = create([...ALL_OPS, 'models.media']);
  const catalog = { vision: [], image: [{ providerId: 'on-host', modelId: 'image', label: 'Image' }], video: [] };
  host.invoke.mockResolvedValueOnce(ok(catalog));
  expect(await target.mediaModels!()).toEqual(catalog);
  expect(sent().input.op).toBe('models.media');
  expect(sent().resourceRef?.id).toBe('bot-1');
});
