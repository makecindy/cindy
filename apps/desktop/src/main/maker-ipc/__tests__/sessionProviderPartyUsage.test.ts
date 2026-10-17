import type { AgentEvent, Session } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  bindingMatchesLocation,
  groupUsageReportOf,
  localUsageProviderOf,
  recordSessionProviderPartyUsage,
} from '../sessionProviderPartyUsage';

function session(overrides: Partial<Record<'id' | 'agentKind' | 'agentDeviceId' | 'remoteHostId' | 'model', unknown>> = {}): Session {
  return { id: 's1', agentKind: 'codex', agentDeviceId: null, remoteHostId: null, model: 'gpt-5.5', ...overrides } as unknown as Session;
}

const done = (usage: Record<string, number>): AgentEvent => ({ type: 'done', data: { usage } }) as unknown as AgentEvent;

describe('localUsageProviderOf', () => {
  it('records a task in a group built here under the group, wherever the Agent ran', () => {
    const binding = { providerId: 'anthropic', memberKey: 'device:studio:anthropic-2', at: 1 };
    expect(localUsageProviderOf({ binding, agentDeviceId: 'studio', remoteHostId: null, providerId: 'anthropic-2' }))
      .toEqual({ providerId: 'anthropic', memberKey: 'device:studio:anthropic-2' });
  });

  it('records other tasks only when the Agent ran on this computer', () => {
    expect(localUsageProviderOf({ binding: null, agentDeviceId: null, remoteHostId: null, providerId: 'openai' }))
      .toEqual({ providerId: 'openai', memberKey: 'local' });
    expect(localUsageProviderOf({ binding: null, agentDeviceId: 'studio', remoteHostId: null, providerId: 'openai' })).toBeNull();
    // 另一台电脑上的组：Agent 在那台运行时由那台记；分到本机运行时记在本机用的供应商上。
    const remote = { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 };
    expect(localUsageProviderOf({ binding: remote, agentDeviceId: 'mini', remoteHostId: null, providerId: 'anthropic' })).toBeNull();
    expect(localUsageProviderOf({ binding: remote, agentDeviceId: null, remoteHostId: null, providerId: 'anthropic-9' }))
      .toEqual({ providerId: 'anthropic-9', memberKey: 'local' });
    expect(localUsageProviderOf({ binding: null, agentDeviceId: null, remoteHostId: 'ssh-1', providerId: 'openai' })).toBeNull();
    expect(localUsageProviderOf({ binding: null, agentDeviceId: null, remoteHostId: null, providerId: null })).toBeNull();
  });

  it('does not follow a binding the task has already moved away from', () => {
    // 绑定还记着 Studio，任务已经挪回本机用 openai：按没有组记。
    const binding = { providerId: 'anthropic', memberKey: 'device:studio:anthropic-2', at: 1 };
    expect(localUsageProviderOf({ binding, agentDeviceId: null, remoteHostId: null, providerId: 'openai' }))
      .toEqual({ providerId: 'openai', memberKey: 'local' });
    // 同一台电脑换了别的供应商也不算。
    expect(localUsageProviderOf({ binding, agentDeviceId: 'studio', remoteHostId: null, providerId: 'openai-3' })).toBeNull();
  });
});

describe('bindingMatchesLocation', () => {
  it('compares where the task runs with the bound computer, in the group computer\'s terms', () => {
    const local = { providerId: 'anthropic', memberKey: 'local', at: 1 };
    expect(bindingMatchesLocation(local, { agentDeviceId: null, providerId: 'anthropic' })).toBe(true);
    // 跟随默认路由(没记供应商)时只比电脑。
    expect(bindingMatchesLocation(local, { agentDeviceId: null, providerId: null })).toBe(true);
    expect(bindingMatchesLocation(local, { agentDeviceId: 'studio', providerId: 'anthropic' })).toBe(false);
    // 另一台电脑(mini)上的组：mini 自己是 local；本机是 device:<本机>。
    const remoteLocal = { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 };
    expect(bindingMatchesLocation(remoteLocal, { agentDeviceId: 'mini', providerId: 'anthropic' })).toBe(true);
    const self = { providerId: 'anthropic', memberKey: 'device:laptop:anthropic-9', groupDeviceId: 'mini', at: 1 };
    expect(bindingMatchesLocation(self, { agentDeviceId: null, providerId: 'anthropic-9', selfDeviceId: 'laptop' })).toBe(true);
    expect(bindingMatchesLocation(self, { agentDeviceId: null, providerId: 'anthropic-9', selfDeviceId: null })).toBe(false);
    const share = { providerId: 'anthropic', memberKey: 'share:s1:anthropic', groupDeviceId: 'mini', at: 1 };
    expect(bindingMatchesLocation(share, { agentDeviceId: 'share:s1', providerId: 'anthropic' })).toBe(true);
    expect(bindingMatchesLocation(share, { agentDeviceId: 'share:s2', providerId: 'anthropic' })).toBe(false);
  });
});

describe('recordSessionProviderPartyUsage', () => {
  it('records one round per done event with its tokens', () => {
    const record = vi.fn();
    const deps = { providerOf: () => 'openai', bindingOf: () => null, record };
    const target = session();
    recordSessionProviderPartyUsage(deps, target, { type: 'text', data: {} } as unknown as AgentEvent);
    recordSessionProviderPartyUsage(deps, target, done({ promptTokens: 120, completionTokens: 30 }));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      kind: 'codex',
      providerId: 'openai',
      memberKey: 'local',
      samples: [expect.objectContaining({ model: 'gpt-5.5', turns: 1, inputTokens: 120, outputTokens: 30 })],
    });
  });

  it('skips rounds whose Agent ran on another computer', () => {
    const record = vi.fn();
    recordSessionProviderPartyUsage(
      { providerOf: () => 'openai', bindingOf: () => null, record },
      session({ agentDeviceId: 'studio' }),
      done({ promptTokens: 1, completionTokens: 1 }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps a round run through another computer\'s group on a third computer, to report it to that group', () => {
    const record = vi.fn();
    const recordForGroup = vi.fn();
    const binding = { providerId: 'anthropic', memberKey: 'device:studio:anthropic-2', groupDeviceId: 'mini', at: 1 };
    recordSessionProviderPartyUsage(
      { providerOf: () => 'anthropic-2', bindingOf: () => binding, record, recordForGroup },
      session({ agentDeviceId: 'studio' }),
      done({ promptTokens: 5, completionTokens: 2 }),
    );
    expect(record).not.toHaveBeenCalled();
    expect(recordForGroup).toHaveBeenCalledWith({
      kind: 'codex',
      groupDeviceId: 'mini',
      providerId: 'anthropic',
      memberKey: 'device:studio:anthropic-2',
      samples: [expect.objectContaining({ inputTokens: 5, outputTokens: 2 })],
    });
  });
});

describe('groupUsageReportOf', () => {
  it('reports only rounds the group computer did not run itself, and only while the task is still on the bound computer', () => {
    const remote = { providerId: 'anthropic', memberKey: 'device:studio:anthropic-2', groupDeviceId: 'mini', at: 1 };
    const onStudio = { agentDeviceId: 'studio', providerId: 'anthropic-2', selfDeviceId: 'laptop' };
    expect(groupUsageReportOf({ binding: remote, remoteHostId: null, ...onStudio }))
      .toEqual({ groupDeviceId: 'mini', providerId: 'anthropic', memberKey: 'device:studio:anthropic-2' });
    // 分到组所在电脑本身：它自己记过。
    expect(groupUsageReportOf({ binding: { ...remote, memberKey: 'local' }, remoteHostId: null, agentDeviceId: 'mini', providerId: 'anthropic' })).toBeNull();
    // 任务已经挪走(绑定还没清)：不报。
    expect(groupUsageReportOf({ binding: remote, remoteHostId: null, agentDeviceId: 'mini', providerId: 'anthropic' })).toBeNull();
    expect(groupUsageReportOf({ binding: remote, remoteHostId: null, agentDeviceId: null, providerId: 'openai', selfDeviceId: 'laptop' })).toBeNull();
    // 本机的组、没有组、SSH 远程工作区：不报。
    expect(groupUsageReportOf({ binding: { providerId: 'anthropic', memberKey: 'device:x:y', at: 1 }, remoteHostId: null, agentDeviceId: 'x', providerId: 'y' })).toBeNull();
    expect(groupUsageReportOf({ binding: null, remoteHostId: null, ...onStudio })).toBeNull();
    expect(groupUsageReportOf({ binding: remote, remoteHostId: 'ssh-1', ...onStudio })).toBeNull();
  });
});
