/**
 * 定时任务按模式选来源(model-groups.md §6.3「定时任务与自动化：每次运行时按模式重新选」)。
 *
 * 测试价值
 * - 生产入口与可观察结果：createScheduleModelGroupPicker 交给 runner 的本次运行模型字段，以及运行开始后
 *   对选路记录、任务绑定与说明的调用。
 * - 现有覆盖缺口：定时任务此前只存具体模型，没有按模式选的路径。
 * - 最小失败输入：绑定任务被模式换到另一台电脑；新建任务选到另一台的来源却仍在本机跑；
 *   模式已删除时仍写说明或改了模型；里面都用不了时没写明沿用；两次运行共用一条说明。
 * - tier：unit(注入端口，不碰数据库与选路依赖)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Schedule } from '@cindy/maker-scheduler';

import type { ModelGroupResolveRequest, ModelGroupResolveResult } from '../../../shared/modelGroups';
import { createScheduleModelGroupPicker, type ScheduleModelGroupPorts } from '../schedulePick';

const schedule = {
  id: 's1', name: 'Daily', agentKind: 'codex', modelAgentKind: 'codex', model: 'gpt-saved', providerId: 'openai',
  modelGroup: 'daily',
} as Schedule;

const routed = (agentDeviceId?: string): ModelGroupResolveResult => ({
  outcome: 'routed', decisionId: 'd1', groupName: 'Daily mode', modelName: 'GPT Astra', sourceName: 'Work',
  route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-astra', effort: 'high', ...(agentDeviceId ? { agentDeviceId } : {}) },
  why: 'order', quota: null, trace: [{ state: 'picked', limitedUntilMs: null } as never],
});

function ports(result: ModelGroupResolveResult, location: { agentDeviceId: string | null; ssh: boolean } | undefined = undefined) {
  let now = 1_000;
  const calls = {
    resolve: [] as ModelGroupResolveRequest[],
    commit: vi.fn(), bind: vi.fn(), writeNote: vi.fn(),
  };
  const value: ScheduleModelGroupPorts = {
    resolve: async (request) => { calls.resolve.push(request); return result; },
    commit: calls.commit,
    bind: calls.bind,
    sessionLocation: async () => location,
    writeNote: calls.writeNote,
    t: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key),
    locale: () => 'en',
    locationName: () => 'Studio',
    now: () => (now += 1),
  };
  return { value, calls };
}

describe('scheduled runs pick from their model group', () => {
  it('runs a new task on the picked source and its computer, and records it once the run starts', async () => {
    const { value, calls } = ports(routed('desk-2'));
    const pick = await createScheduleModelGroupPicker(value)(schedule);
    expect(calls.resolve[0]).toEqual({ selection: { type: 'route', id: 'daily' } });
    expect(pick?.route).toEqual({ modelAgentKind: 'codex', model: 'gpt-astra', providerId: 'openai-work', effort: 'high', modelAgentDeviceId: 'desk-2' });
    expect(calls.commit).not.toHaveBeenCalled();
    pick!.started('task-1');
    expect(calls.commit).toHaveBeenCalledWith('d1');
    expect(calls.bind).toHaveBeenCalledWith('task-1', { type: 'route', id: 'daily' }, 'codex\u0000openai-work\u0000gpt-astra\u0000desk-2');
    const [, note, options] = calls.writeNote.mock.calls[0]!;
    expect(note).toMatchObject({ pluginName: 'Daily mode', outcome: 'routed', source: 'model-group' });
    expect(note.modelName).toContain('GPT Astra');
    expect(options.clientId).toBe('model-group-route:task-1:d1');
  });

  it('a local pick runs on this computer', async () => {
    const pick = await createScheduleModelGroupPicker(ports(routed()).value)(schedule);
    expect(pick?.route?.modelAgentDeviceId).toBe('');
  });

  it('a bound task is picked where it already runs and keeps following it', async () => {
    const { value, calls } = ports(routed('desk-2'), { agentDeviceId: 'desk-2', ssh: false });
    const pick = await createScheduleModelGroupPicker(value)({ ...schedule, targetSessionId: 'task-9' } as Schedule);
    expect(calls.resolve[0]).toEqual({ selection: { type: 'route', id: 'daily' }, location: { agentDeviceId: 'desk-2' } });
    expect(pick?.route).toHaveProperty('modelAgentDeviceId', undefined);
  });

  // PR #11881 review r4651177678: an SSH task looked local, so the mode could pick another engine or a local
  // source and the SSH run then failed. Modes are not used for SSH yet (model-groups.md §6, §9).
  it('a bound SSH task keeps its saved model and is not picked', async () => {
    const { value, calls } = ports(routed(), { agentDeviceId: null, ssh: true });
    expect(await createScheduleModelGroupPicker(value)({ ...schedule, targetSessionId: 'ssh-task' } as Schedule)).toBeNull();
    expect(calls.resolve).toHaveLength(0);
  });

  it('a deleted mode runs the saved model and writes nothing', async () => {
    const { value, calls } = ports({ outcome: 'missing', groupName: 'Gone', trace: [] });
    expect(await createScheduleModelGroupPicker(value)(schedule)).toBeNull();
    expect(calls.writeNote).not.toHaveBeenCalled();
  });

  it('a mode with nothing usable keeps the saved model and says so in the task', async () => {
    const { value, calls } = ports({ outcome: 'unavailable', groupName: 'Daily mode', trace: [] });
    const pick = await createScheduleModelGroupPicker(value)(schedule);
    expect(pick?.route).toBeUndefined();
    pick!.started('task-1');
    expect(calls.bind).not.toHaveBeenCalled();
    expect(calls.writeNote.mock.calls[0]![1]).toMatchObject({ outcome: 'kept', modelName: 'gpt-saved', why: 'unavailable-route' });
  });

  it('a schedule without a mode is left alone', async () => {
    const { value, calls } = ports(routed());
    expect(await createScheduleModelGroupPicker(value)({ ...schedule, modelGroup: undefined } as Schedule)).toBeNull();
    expect(calls.resolve).toHaveLength(0);
  });
});
