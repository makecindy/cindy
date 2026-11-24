/**
 * Switching an existing task to or from a plugin engine (docs/plans/acp-plugin-bridge.md, phase 2).
 *
 * 测试价值
 * - 生产入口与可观察结果：maker:switch-session-agent 的业务体 performSessionAgentSwitch(登记意图与
 *   发送时 applyNow 提交)和发送前的 applyPendingAgentSwitchIfIdle；看落库字段、分隔条、交接说明、
 *   是否启动 / 续接原生会话，以及被拒绝的原因。
 * - 规则依据：2026-11-19 用户要求插件引擎与内置引擎在任务里一样能互相切换；插件引擎只在本机运行，
 *   不能导入别处的历史(总带完整交接)，插件停用时不能悄悄留在原引擎发送。
 * - 现有覆盖缺口：此前插件引擎任务的切换一律被拒绝，没有任何测试走过插件引擎参与的切换事务。
 * - 最小失败输入：内置任务切到插件引擎时把 'acp' 落成 'cc' / 续接 Claude 的原生会话 / 沿用 Fast；
 *   插件引擎任务切回内置引擎时把 acp-plugin: 来源留在内置任务上；IM 任务或停用的插件被放行；
 *   插件停用后发送仍在原引擎继续。
 * - tier：unit(依赖注入，与 sessionAgentSwitchHandler.test.ts 同一套 harness 形状)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../sessionAgentSwitchHandler';

const ENGINE = 'acp-plugin:_ns__local__dsh-acp:dsh';

function makeRow(overrides: Partial<AgentSwitchSessionRow> = {}): AgentSwitchSessionRow {
  return {
    id: 's1',
    agentKind: 'cc',
    model: 'claude-fable-5',
    providerId: 'xd',
    status: 'active',
    remoteHostId: null,
    orcaRole: null,
    sdkSessionId: 'sdk-claude',
    source: 'desktop',
    permissionMode: 'acceptEdits',
    ...overrides,
  };
}

function makeDeps(row: AgentSwitchSessionRow, overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
  const pendingSwitches = createPendingAgentSwitchRegistry();
  const deps: MakerSessionAgentSwitchHandlerDeps = {
    getSessionRow: vi.fn(async () => row),
    getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    closeSession: vi.fn(async () => {}),
    listMessagesForHandoff: vi.fn(async () => [
      { role: 'user', content: '帮我改一下登录页', createdAt: 1 },
      { role: 'assistant', content: '已经改好了。', createdAt: 2 },
    ]),
    findParkedEngineSession: vi.fn(async () => null),
    applyAgentSwitchToDb: vi.fn(async () => {}),
    setSessionProvider: vi.fn(),
    insertBoundaryMessage: vi.fn(async () => 'boundary-1'),
    applyResumeFallbackAtomically: vi.fn(async () => {}),
    setPendingHandoff: vi.fn(),
    bootstrapSwitchedSession: vi.fn(async () => {}),
    withCloseSuppressed: vi.fn((_sessionId, fn) => fn()),
    assertModelRouteUsable: vi.fn(async () => undefined),
    // DSH 只提供它自己的模式与「全部允许」，deepseek-v4 有 low / high / max 三档。
    admitPluginEngineTarget: vi.fn((target) => ({
      model: target.model,
      effort: target.effort === 'high' || target.effort === 'max' ? target.effort : '',
      permissionMode: target.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default',
      engineName: 'DeepSeek Harness',
    })),
    describePluginEngine: vi.fn((providerId) => (providerId === ENGINE ? 'DeepSeek Harness' : null)),
    pendingSwitches,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, pendingSwitches };
}

describe('switching a task onto a plugin engine', () => {
  it('stages the choice, then commits it as the plugin engine with a full handoff and no native resume', async () => {
    const { deps, pendingSwitches } = makeDeps(makeRow());
    const staged = await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, effort: 'high', fastMode: true,
    });
    expect(staged).toMatchObject({ deferred: true, agentKind: 'acp' });
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE });
    // Staging never touches the task or the built-in catalog check.
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(deps.assertModelRouteUsable).not.toHaveBeenCalled();

    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, effort: 'high', fastMode: true,
      applyNow: true,
    });
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, sdkSessionId: null,
      effort: 'high', fastMode: false, permissionMode: 'default',
    });
    // A plugin engine cannot import Cindy's history or resume an earlier native session.
    expect(deps.findParkedEngineSession).not.toHaveBeenCalled();
    expect(deps.bootstrapSwitchedSession).not.toHaveBeenCalled();
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      fromAgentKind: 'cc', toAgentKind: 'acp', toProviderId: ENGINE, toEngineName: 'DeepSeek Harness',
      fromSdkSessionId: 'sdk-claude', resumed: false,
    }));
    const handoff = vi.mocked(deps.setPendingHandoff).mock.calls[0]?.[1] ?? '';
    expect(handoff).toContain('DeepSeek Harness');
    expect(handoff).toContain('帮我改一下登录页');
  });

  it.each([
    { name: 'another computer', row: { agentDeviceId: 'mini' }, code: 'PRECONDITION_FAILED' },
    { name: 'an IM task', row: { source: 'feishu' }, code: 'UNSUPPORTED_CAPABILITY' },
    { name: 'a collaboration lead', row: { orcaRole: 'lead' }, code: 'UNSUPPORTED_CAPABILITY' },
  ])('refuses $name before staging anything', async ({ row, code }) => {
    const { deps, pendingSwitches } = makeDeps(makeRow(row));
    await expect(performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE,
    })).rejects.toThrow(`[${code}]`);
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(deps.admitPluginEngineTarget).not.toHaveBeenCalled();
  });

  it('refuses an engine whose plugin was turned off, and blocks the send instead of staying on the old engine', async () => {
    let pluginEnabled = true;
    const { deps, pendingSwitches } = makeDeps(makeRow(), {
      admitPluginEngineTarget: vi.fn((target) => {
        if (!pluginEnabled) throw new Error('提供这个引擎的插件已停用或卸载。请重新选择模型。');
        return { model: target.model, effort: '', permissionMode: 'default', engineName: 'DeepSeek Harness' };
      }),
    });
    await performSessionAgentSwitch(deps, { sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE });
    pluginEnabled = false;
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('插件已停用');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    // The choice stays so the user can pick again; nothing was sent on Claude Code meanwhile.
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'acp' });
  });

  it('needs the engine identity', async () => {
    const { deps } = makeDeps(makeRow());
    await expect(performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: 'xd',
    })).rejects.toThrow('[INVALID_PARAMS]');
  });
});

describe('switching a plugin-engine task back to a built-in engine', () => {
  const pluginRow = () => makeRow({
    agentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, sdkSessionId: 'acp-session', permissionMode: 'default',
  });

  it('does not keep the plugin engine as the built-in source and resumes the parked built-in session', async () => {
    const { deps } = makeDeps(pluginRow(), {
      findParkedEngineSession: vi.fn(async () => ({ sdkSessionId: 'sdk-claude', watermarkCreatedAt: 1, watermarkRowid: 1 })),
    });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'claude-code', model: 'claude-fable-5', applyNow: true,
    });
    expect(deps.findParkedEngineSession).toHaveBeenCalledWith('s1', 'cc', null);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'cc', model: 'claude-fable-5', providerId: null, sdkSessionId: 'sdk-claude',
    }));
    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', null);
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      fromAgentKind: 'acp', toAgentKind: 'cc', fromEngineName: 'DeepSeek Harness', fromProviderId: ENGINE,
    }));
    // The parked Claude Code session is resumed eagerly so a stale binding falls back in the same switch.
    expect(deps.bootstrapSwitchedSession).toHaveBeenCalled();
  });

  it('treats picking its own engine as cancelling a staged switch, without a built-in model selection', async () => {
    const selectSameAgentModel = vi.fn(async () => ({ deferred: true }));
    const { deps, pendingSwitches } = makeDeps(pluginRow(), { selectSameAgentModel });
    await performSessionAgentSwitch(deps, { sessionId: 's1', targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'codex' });

    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE,
    });
    expect(result).toMatchObject({ switched: false });
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(selectSameAgentModel).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });
});
