import { describe, expect, it, vi } from 'vitest';

import { createPluginEngineLearnSession } from '../pluginEngineLearnSession';

// 2026-11-25 用户要求插件引擎在所有地方与内置引擎一样可用：/learn 此前对插件引擎任务直接报
// 「Learn is not available for tasks running on a plugin engine」。生产入口 createPluginEngineLearnSession
// (learn-host 的 createSession 在来源任务为 acp 时调用)；可观察结果是交给 maker.createSession 的蒸馏任务参数。
// 最小失败输入：来源任务 agentKind=acp、provider=acp-plugin:agy:agy。tier：unit(maker 与准入为桩)。
describe('createPluginEngineLearnSession', () => {
  const opts = { id: 'learn-1', workingDir: '/staging/learn-1', title: 'Learn' };
  const provider = 'acp-plugin:agy:agy';

  function fixture(admitted = { model: 'gemini-3-pro', effort: 'high', permissionMode: 'default' }) {
    const order: string[] = [];
    const deps = {
      maker: { createSession: vi.fn(async () => { order.push('create'); return { id: opts.id } as never; }) },
      admitPluginEngine: vi.fn(() => admitted),
      setSessionProvider: vi.fn(() => { order.push('provider'); }),
    };
    return { deps, order };
  }

  it('distills on the same plugin engine and model, asking for each action', async () => {
    const { deps, order } = fixture();
    await createPluginEngineLearnSession(deps, opts, { model: 'gemini-3-pro', effort: 'high' }, provider);
    expect(deps.admitPluginEngine).toHaveBeenCalledWith({ providerId: provider, model: 'gemini-3-pro', effort: 'high',
      permissionMode: 'default' });
    expect(deps.maker.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'learn-1', agentKind: 'acp', providerId: provider, model: 'gemini-3-pro', effort: 'high',
      permissionMode: 'default', fastMode: false, workingDir: '/staging/learn-1',
    }));
    expect(order).toEqual(['provider', 'create']);
  });

  it('never distills with full access, even when the engine would start there', async () => {
    const { deps } = fixture({ model: 'm', effort: '', permissionMode: 'bypassPermissions' });
    await expect(createPluginEngineLearnSession(deps, opts, {}, provider)).rejects.toThrow('plugin engine');
    expect(deps.maker.createSession).not.toHaveBeenCalled();
  });

  it('keeps an engine on another computer there, without checking this computer’s engines', async () => {
    const { deps } = fixture();
    await createPluginEngineLearnSession(deps, opts, { model: 'gemini-3-pro', agentDeviceId: 'studio' }, provider);
    expect(deps.admitPluginEngine).not.toHaveBeenCalled();
    expect(deps.maker.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'acp', agentDeviceId: 'studio', permissionMode: 'default',
    }));
  });
});
