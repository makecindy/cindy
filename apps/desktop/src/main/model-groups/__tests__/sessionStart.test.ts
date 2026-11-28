/**
 * 模式跟着任务走(model-groups.md §6.3 原则，2026-11-22 用户裁决)：入口新建任务前按模式选来源，任务层在这个任务
 * 第一轮派发时提交选路、记下绑定(之后的接替按它走)并在那条消息下面写说明。
 *
 * 测试价值
 * - 生产入口与可观察结果：createModelGroupSessionStart 给入口的来源与凭据，以及派发后对提交、绑定、说明的调用。
 * - 现有覆盖缺口：此前每个入口各写一份选路与记账(定时任务的 schedulePick)，没有任务层的公共一份。
 * - 最小失败输入：选了就提交(没建成任务也推进轮流)；凭据没挂到任务上就结算；说明挂到别的消息下面；
 *   同一个任务第二轮又结算一次；模式已删除仍写说明；只在本机运行的入口选到别的电脑。
 * - tier：unit(注入端口，不碰数据库与解析器)。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ModelGroupResolveRequest, ModelGroupResolveResult } from '../../../shared/modelGroups';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { createModelGroupSessionStart, type ModelGroupSessionStartPorts } from '../sessionStart';

const routed = (agentDeviceId?: string): ModelGroupResolveResult => ({
  outcome: 'routed', decisionId: 'd1', groupName: 'Daily mode', modelName: 'GPT Astra', sourceName: 'Work',
  route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-astra', effort: 'high', ...(agentDeviceId ? { agentDeviceId } : {}) },
  why: 'order', quota: null, trace: [{ state: 'picked', limitedUntilMs: null } as never],
});

function ports(result: ModelGroupResolveResult) {
  const calls = { resolve: [] as ModelGroupResolveRequest[], commit: vi.fn(), bind: vi.fn(), writeNote: vi.fn() };
  let token = 0;
  const value: ModelGroupSessionStartPorts = {
    resolve: async (request) => { calls.resolve.push(request); return result; },
    commit: calls.commit,
    bind: calls.bind,
    writeNote: calls.writeNote,
    t: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key),
    locale: () => 'en',
    locationName: () => 'Studio',
    now: () => 1_000,
    createToken: () => `tok-${(token += 1)}`,
  };
  return { value, calls };
}

describe('a mode picks the first source of a new task and is settled when its first turn is dispatched', () => {
  // 2026-11-26 audit: only the scheduler caught a failing resolve; a Worker or other entry failed to create its
  // task. Minimal input: resolve throws. Expected: the entry creates the task on its saved model.
  it('creates the task on its saved model when routing itself fails', async () => {
    const { value } = ports(routed());
    const start = createModelGroupSessionStart({ ...value, resolve: async () => { throw new Error('catalog read failed'); } });
    await expect(start.prepare('daily', { keptModelName: 'gpt-saved' })).resolves.toBeNull();
  });

  it('gives the entry the picked source and settles only at dispatch, under that message, once', async () => {
    const { value, calls } = ports(routed('desk-2'));
    const start = createModelGroupSessionStart(value);
    const prepared = await start.prepare('daily', { keptModelName: 'gpt-saved' });
    expect(calls.resolve[0]).toEqual({ selection: { type: 'route', id: 'daily' } });
    expect(prepared).toEqual({
      route: { agentKind: 'codex', model: 'gpt-astra', providerId: 'openai-work', effort: 'high', agentDeviceId: 'desk-2' },
      token: 'tok-1',
    });
    start.dispatched('task-1', 'msg-1');
    expect(calls.commit).not.toHaveBeenCalled();
    start.attach('task-1', prepared!.token);
    // The record exists before the first turn is sent, so a first-turn failure can be taken over (§6).
    expect(calls.bind).toHaveBeenCalledWith('task-1', { type: 'route', id: 'daily' }, 'codex\u0000openai-work\u0000gpt-astra\u0000desk-2');
    expect(calls.commit).not.toHaveBeenCalled();
    start.dispatched('task-1', 'msg-1');
    expect(calls.commit).toHaveBeenCalledWith('d1');
    expect(calls.bind).toHaveBeenCalledOnce();
    const [, note, options] = calls.writeNote.mock.calls[0]!;
    expect(note).toMatchObject({ pluginName: 'Daily mode', outcome: 'routed', source: 'model-group' });
    expect(options).toEqual({ clientId: 'model-group-route:task-1:d1', anchorClientId: 'msg-1' });
    start.dispatched('task-1', 'msg-2');
    expect(calls.commit).toHaveBeenCalledOnce();
    expect(calls.writeNote).toHaveBeenCalledOnce();
  });

  // model-groups.md §3(2026-11-26，dash 建议)：本机来源背后是电脑组或几个账号时，说明写到实际分到的那台电脑或账号；
  // 别的电脑上的来源不问(那台自己分)，读不到时照旧写，不让说明迟迟不出现。
  it('names the computer or account the inner group or pool assigned, only for a local source', async () => {
    const run = async (result: ModelGroupResolveResult, innerChoice: ModelGroupSessionStartPorts['innerChoice']) => {
      const { value, calls } = ports(result);
      const start = createModelGroupSessionStart({ ...value, innerChoice });
      start.attach('task-1', (await start.prepare('daily', { keptModelName: 'gpt-saved' }))!.token);
      start.dispatched('task-1', 'msg-1');
      await vi.waitFor(() => expect(calls.writeNote).toHaveBeenCalledOnce());
      return calls.writeNote.mock.calls[0]![1].modelName as string;
    };
    const asked = vi.fn(async () => 'work@example.com');
    expect(await run(routed(), asked)).toMatch(/ · work@example\.com$/);
    expect(asked).toHaveBeenCalledWith('task-1', { providerId: 'openai-work', model: 'gpt-astra' });
    expect(await run(routed(), async () => null)).not.toContain('work@example.com');
    const remote = vi.fn(async () => 'never');
    expect(await run(routed('desk-2'), remote)).not.toContain('never');
    expect(remote).not.toHaveBeenCalled();
  });

  it('keeps the saved model when nothing is usable and says so; a deleted mode changes nothing', async () => {
    const kept = ports({ outcome: 'unavailable', groupName: 'Daily mode', trace: [] });
    const start = createModelGroupSessionStart(kept.value);
    const prepared = await start.prepare('daily', { keptModelName: 'gpt-saved' });
    expect(prepared).toEqual({ token: 'tok-1' });
    start.attach('task-1', prepared!.token);
    start.dispatched('task-1', 'msg-1');
    expect(kept.calls.bind).not.toHaveBeenCalled();
    expect(kept.calls.writeNote.mock.calls[0]![1]).toMatchObject({ outcome: 'kept', modelName: 'gpt-saved' });

    const missing = ports({ outcome: 'missing', groupName: 'Gone', trace: [] });
    expect(await createModelGroupSessionStart(missing.value).prepare('gone', { keptModelName: 'gpt-saved' })).toBeNull();
  });

  it('picks only local sources for an entry that runs on this computer, and checks admission without a token', async () => {
    const { value, calls } = ports(routed());
    const start = createModelGroupSessionStart(value);
    await start.prepare('daily', { keptModelName: 'gpt-saved', localOnly: true });
    expect(calls.resolve[0]).toEqual({ selection: { type: 'route', id: 'daily' }, location: { agentDeviceId: null } });
    expect(await start.canRoute('daily')).toBe(true);
    expect(calls.resolve[1]).toEqual({ selection: { type: 'route', id: 'daily' }, dryRun: true });
    expect(await start.exists('daily')).toBe(true);
    expect(await createModelGroupSessionStart(ports({ outcome: 'missing', groupName: 'Gone', trace: [] }).value).exists('gone')).toBe(false);
  });

  // 2026-11-28 回归：拆平后的单账号选路在 attach 时必须调用 pinLocalSource 固定账号槽位，
  // 且 dispatched 直接写明已含账号名的说明、不再等待内层 innerChoice。
  it('pins the picked local accountId on attach and skips innerChoice when already flattened', async () => {
    const pinned: Array<{ sessionId: string; route: { providerId: string; accountId?: string } }> = [];
    const innerChoice = vi.fn(async () => 'should-not-run');
    const base = ports({
      outcome: 'routed',
      decisionId: 'dec-flat',
      groupName: 'OpenAI',
      route: { agentKind: 'codex', providerId: 'openai', accountId: 'second', model: 'gpt-6.2' },
      modelName: 'GPT-6.2',
      sourceName: 'OpenAI · second@example.com',
      why: 'expiring',
      quota: null,
      trace: [],
    });
    const start = createModelGroupSessionStart({
      ...base.value,
      pinLocalSource: (sessionId, route) => { pinned.push({ sessionId, route }); },
      innerChoice,
    });
    const prepared = await start.prepare('src:openai-gpt', { keptModelName: 'gpt-saved' });
    expect(prepared?.route).toMatchObject({ providerId: 'openai', accountId: 'second' });
    start.attach('s-flat', prepared!.token);
    expect(pinned).toEqual([{ sessionId: 's-flat', route: { providerId: 'openai', accountId: 'second' } }]);
    expect(base.calls.bind.mock.calls[0]?.[2]).toContain('acct:second');
    start.dispatched('s-flat', 'user-1');
    expect(innerChoice).not.toHaveBeenCalled();
    expect(base.calls.writeNote.mock.calls[0]?.[1]?.modelName).toBe('GPT-6.2 · OpenAI · second@example.com · Codex');
  });
});
