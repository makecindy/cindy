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
import { providerShareGuestPeer } from '@cindy/device-link';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context';

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
  // #12397: a finished, separate automation task keeps its conversation and
  // hands it to the selected plugin on the next manual send. Unit, same harness.
  it.each([false, true])('applies a local plugin selection on next send from a completed automation (remote=%s)', async (remote) => {
    const { deps, pendingSwitches } = makeDeps(makeRow({ source: 'scheduler' }), {
      canSwitchCompletedAutomationSession: vi.fn(async () => true),
    });
    const staged = await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE,
      localWindowRequest: true,
    });

    expect(staged).toMatchObject({ deferred: true, agentKind: 'acp' });
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    const send = () => applyPendingAgentSwitchIfIdle(deps, 's1');
    await (remote ? runDeviceLinkInvokeContext({ controllerDeviceId: 'my-device', channel: 'maker:send' }, send) : send());
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', providerId: ENGINE, model: 'deepseek-v4', sdkSessionId: null,
    }));
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.stringContaining('DeepSeek Harness'), undefined);
    expect(pendingSwitches.get('s1')).toBeUndefined();
  });

  // #12397: deleting a schedule can remove the run while keeping its task.
  it('can return a kept automation task to a builtin after its run is gone', async () => {
    const { deps } = makeDeps(makeRow({ source: 'scheduler', agentKind: 'acp', providerId: ENGINE }), {
      canSwitchCompletedAutomationSession: vi.fn(async (_sessionId, returningToBuiltin) => returningToBuiltin),
    });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'claude-code', model: 'claude-fable-5', localWindowRequest: true,
    });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'cc', providerId: null, model: 'claude-fable-5',
    }));
  });

  // #12397: at the production pre-send entry, a stale builtin route must
  // reject the send and retain the choice. The success case above cannot
  // detect fallback to the old plugin. Unit input: disable the selected
  // provider after staging a switch from a completed automation's plugin.
  it('blocks a manual automation send when the selected builtin route becomes unavailable', async () => {
    const { deps, pendingSwitches } = makeDeps(makeRow({ source: 'scheduler', agentKind: 'acp', providerId: ENGINE }), {
      canSwitchCompletedAutomationSession: vi.fn(async (_sessionId, returningToBuiltin) => returningToBuiltin),
    });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'claude-code', model: 'claude-fable-5', providerId: 'xd',
      localWindowRequest: true,
    });
    const routeError = new Error('Selected provider is disabled');
    vi.mocked(deps.assertModelRouteUsable!).mockRejectedValueOnce(routeError);

    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toBe(routeError);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'claude-code', providerId: 'xd' });
  });

  it('lets a newly bound automation send without consuming a pending manual plugin choice', async () => {
    const canSwitchCompletedAutomationSession = vi.fn(async () => true);
    const { deps, pendingSwitches } = makeDeps(makeRow({ source: 'scheduler' }), {
      canSwitchCompletedAutomationSession,
    });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE,
      localWindowRequest: true,
    });
    canSwitchCompletedAutomationSession.mockResolvedValue(false);

    // The scheduler uses the saved route. The next manual send still gets a
    // refusal instead of quietly sending through the previous engine.
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1', { scheduled: true })).resolves.toBeUndefined();
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'acp' });
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('[UNSUPPORTED_CAPABILITY]');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'acp' });
  });

  // #12397: a persistent automation that uses its task's model should
  // continue applying any staged builtin-to-builtin choice on its next send.
  it('applies a builtin engine choice on the next scheduled send from a bound task', async () => {
    const { deps, pendingSwitches } = makeDeps(makeRow({ source: 'scheduler' }), {
      canSwitchCompletedAutomationSession: vi.fn(async () => false),
    });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'codex', model: 'gpt-5.4', localWindowRequest: true,
    });

    await applyPendingAgentSwitchIfIdle(deps, 's1', { scheduled: true });
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'codex', model: 'gpt-5.4',
    }));
    expect(pendingSwitches.get('s1')).toBeUndefined();
  });

  it.each([false, true])('requires a trusted window choice for an automation switch (applyNow=%s)', async (applyNow) => {
    const { deps, pendingSwitches } = makeDeps(makeRow({ source: 'scheduler' }), {
      canSwitchCompletedAutomationSession: vi.fn(async () => true),
    });
    await expect(performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE, applyNow,
    })).rejects.toThrow('[UNSUPPORTED_CAPABILITY]');
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

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

  // 2026-11-19 用户反馈：供应商组按额度把任务的 Agent 挪到另一台电脑后，列表里就选不到插件引擎了。
  // 插件引擎只在任务所在电脑运行，切过去就是把 Agent 换回这台(与内置引擎之间换电脑同一套交接)；
  // 点名另一台电脑仍拒绝。最小失败输入：agentDeviceId=mini 的任务切到插件引擎；请求带 agentDeviceId。
  it('brings the Agent back to this computer when it ran on another one', async () => {
    const { deps, pendingSwitches } = makeDeps(makeRow({ agentDeviceId: 'mini' }));
    await performSessionAgentSwitch(deps, { sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE });
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'acp', targetAgentDeviceId: null });

    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, applyNow: true,
    });
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', providerId: ENGINE, sdkSessionId: null, agentDeviceId: null,
    }));
    expect(deps.insertBoundaryMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      fromAgentKind: 'cc', toAgentKind: 'acp', fromAgentDeviceId: 'mini', toAgentDeviceId: null,
    }));
  });

  // 生产入口与可观察结果：performSessionAgentSwitch 登记远程位置，applyPendingAgentSwitchIfIdle 按该电脑的目录落库。
  // 依据：2026-11-20 用户反馈普通任务用其他供应商模型创建后，模型列表也应能看到并切到同账号远程插件引擎。
  // 覆盖缺口：此前普通任务带 agentDeviceId 切到 acp 一律被 PRECONDITION_FAILED 拒绝；且从同一台电脑的内置模型切到同机插件引擎时因 agentDeviceChanges=false 丢失 targetAgentDeviceId。
  // 最小失败输入与 tier：unit，agentDeviceId='mini' 的 Claude 会话切到 agentDeviceId='mini' 的插件引擎并执行 applyPendingAgentSwitchIfIdle。
  it.each([null, 'mini'])('switches from an ordinary provider on %s to the offered engine on mini', async (agentDeviceId) => {
    const REMOTE_ENGINE = 'acp-plugin:_ns__local__agy-acp:agy';
    const admitRemotePluginEngineTarget = vi.fn(async (_deviceId: string, target: { model: string }) => ({
      model: target.model,
      effort: 'high',
      permissionMode: 'default',
      engineName: 'Antigravity',
    }));
    const row = makeRow({ agentKind: 'cc', model: 'claude-opus-5-5', providerId: 'anthropic', agentDeviceId });
    const { deps, pendingSwitches } = makeDeps(row, { admitRemotePluginEngineTarget });

    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'gemini-3-pro', providerId: REMOTE_ENGINE, agentDeviceId: 'mini',
    });
    expect(admitRemotePluginEngineTarget).toHaveBeenCalledWith('mini', expect.objectContaining({ providerId: REMOTE_ENGINE, model: 'gemini-3-pro' }));
    expect(pendingSwitches.get('s1')).toMatchObject({
      targetAgentKind: 'acp', providerId: REMOTE_ENGINE, model: 'gemini-3-pro', targetAgentDeviceId: 'mini',
    });

    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.admitPluginEngineTarget).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', providerId: REMOTE_ENGINE, model: 'gemini-3-pro', sdkSessionId: null,
      ...(agentDeviceId !== 'mini' ? { agentDeviceId: 'mini' } : {}),
    }));
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: null }));
    expect(pendingSwitches.get('s1')).toBeUndefined();
  });

  it('switches to a shared plugin engine via remote admission, while rejecting raw wire peers or unwired remote targets', async () => {
    const admitRemotePluginEngineTarget = vi.fn(async () => ({
      model: 'deepseek-v4', effort: 'high', permissionMode: 'default', engineName: 'DeepSeek Harness',
    }));
    const { deps, pendingSwitches } = makeDeps(makeRow(), { admitRemotePluginEngineTarget });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, agentDeviceId: 'share:s1',
    });
    expect(admitRemotePluginEngineTarget).toHaveBeenCalledWith('share:s1', expect.objectContaining({ providerId: ENGINE, model: 'deepseek-v4' }));
    expect(pendingSwitches.get('s1')).toMatchObject({
      targetAgentKind: 'acp', providerId: ENGINE, model: 'deepseek-v4', targetAgentDeviceId: 'share:s1',
    });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.admitPluginEngineTarget).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', providerId: ENGINE, model: 'deepseek-v4', agentDeviceId: 'share:s1', sdkSessionId: null,
    }));

    // Raw wire peers are never valid task agentDeviceId targets (rejected at parameter validation).
    admitRemotePluginEngineTarget.mockClear();
    await expect(performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE,
      agentDeviceId: providerShareGuestPeer('s1', 'm1', 'd1'),
    })).rejects.toThrow('[INVALID_PARAMS]');
    expect(admitRemotePluginEngineTarget).not.toHaveBeenCalled();

    // Without remote admission wired, targeting another computer or share is refused.
    const { deps: noRemoteDeps, pendingSwitches: noRemotePending } = makeDeps(makeRow());
    await expect(performSessionAgentSwitch(noRemoteDeps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE, agentDeviceId: 'mini',
    })).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(noRemotePending.get('s1')).toBeUndefined();
  });

  it('leaves the ordinary route and the intent intact when the execution computer stops offering the engine before send', async () => {
    const admitRemotePluginEngineTarget = vi.fn()
      .mockResolvedValueOnce({ model: 'default', effort: '', permissionMode: 'ask', engineName: 'DSH' })
      .mockRejectedValueOnce(new Error('engine disabled'));
    const { deps, pendingSwitches } = makeDeps(makeRow(), { admitRemotePluginEngineTarget });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'default', providerId: ENGINE, agentDeviceId: 'mini',
    });

    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('engine disabled');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'acp', targetAgentDeviceId: 'mini' });
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

  // 同一次反馈的另一半：插件引擎任务里选供应商组 / 另一台电脑上的内置模型曾被「插件引擎只在本机」拒绝。
  // 目标是内置引擎，按内置引擎换电脑裁决。最小失败输入：acp 任务切到 agentDeviceId=mini 的 Claude Code。
  it('can move to a built-in engine on another computer', async () => {
    const assertAgentDeviceRouteUsable = vi.fn(async () => 200_000);
    const { deps, pendingSwitches } = makeDeps(pluginRow(), { assertAgentDeviceRouteUsable });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'claude-code', model: 'claude-fable-5', providerId: 'anthropic', agentDeviceId: 'mini',
    });
    expect(assertAgentDeviceRouteUsable).toHaveBeenCalledWith('mini', 'claude-code', 'claude-fable-5', 'anthropic');
    expect(pendingSwitches.get('s1')).toMatchObject({ targetAgentKind: 'claude-code', targetAgentDeviceId: 'mini' });
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

  // 第三期(2026-11-20)：任务可以建在另一台电脑的插件引擎上。在这种任务里再选它自己的引擎(不点名位置)是原地
  // 选择，不是「换回本机」：旧逻辑会把位置改成本机，本机恰好也装了同一个插件时 Agent 被悄悄挪走，没装时报
  // 「插件已停用或卸载」。最小失败输入：agentDeviceId=mini 的插件引擎任务，选同一个引擎、不带 agentDeviceId。
  it('keeps a task on its engine of another computer when that same engine is picked again', async () => {
    const { deps, pendingSwitches } = makeDeps({ ...pluginRow(), agentDeviceId: 'mini' });
    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, applyNow: true,
    });
    expect(result).toMatchObject({ switched: false });
    expect(pendingSwitches.get('s1')).toBeUndefined();
    // This computer's engines are not consulted, and nothing moves the Agent.
    expect(deps.admitPluginEngineTarget).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
    expect(deps.insertBoundaryMessage).not.toHaveBeenCalled();
  });

  // Unit, real switch handler: a companion on a shared plugin keeps the active
  // source when selected again, even if a different engine was queued earlier.
  it('clears an older switch when reselecting the current shared companion engine', async () => {
    const agentDeviceId = 'share:friend';
    const { deps, pendingSwitches } = makeDeps({ ...pluginRow(), source: 'bot', agentDeviceId });
    pendingSwitches.set('s1', { targetAgentKind: 'codex', model: 'other-model', providerId: null });

    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, agentDeviceId,
      configStaged: true,
    });

    expect(result).toMatchObject({ switched: false, sameEngineRevision: expect.any(Number) });
    expect(pendingSwitches.get('s1')).toBeUndefined();
    expect(deps.admitPluginEngineTarget).not.toHaveBeenCalled();
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });

  // A saved companion model must switch the existing chat across host, remote and shared plugin engines, discarding the previous SDK session.
  it('runs the chosen host, remote and shared plugins on a companion chat', async () => {
    const OTHER_ENGINE = 'acp-plugin:alternate:engine';
    const botRow = makeRow({ source: 'bot', agentKind: 'pi', model: 'glm-5', providerId: 'xd' });
    const admitRemotePluginEngineTarget = vi.fn(async (_deviceId: string, target: { model: string }) => ({
      model: target.model, effort: '', permissionMode: 'default', engineName: 'Remote Engine',
    }));
    const { deps } = makeDeps(botRow, { admitRemotePluginEngineTarget });

    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, applyNow: true,
    });
    expect(deps.applyAgentSwitchToDb).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, sdkSessionId: null,
    }));

    Object.assign(botRow, { agentKind: 'acp', model: 'deepseek-v4', providerId: ENGINE, sdkSessionId: 'acp-1' });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'second-model', providerId: OTHER_ENGINE, agentDeviceId: 'share:friend', applyNow: true,
    });
    expect(deps.admitRemotePluginEngineTarget).toHaveBeenCalledWith('share:friend', expect.objectContaining({
      providerId: OTHER_ENGINE, model: 'second-model',
    }));
    expect(deps.applyAgentSwitchToDb).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', model: 'second-model', providerId: OTHER_ENGINE, agentDeviceId: 'share:friend', sdkSessionId: null,
    }));

    Object.assign(botRow, { agentKind: 'acp', model: 'second-model', providerId: OTHER_ENGINE, agentDeviceId: 'share:friend', sdkSessionId: 'acp-2' });
    await performSessionAgentSwitch(deps, {
      sessionId: 's1', targetAgentKind: 'acp', model: 'second-model', providerId: OTHER_ENGINE, agentDeviceId: null, applyNow: true,
    });
    expect(deps.applyAgentSwitchToDb).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      agentKind: 'acp', model: 'second-model', providerId: OTHER_ENGINE, agentDeviceId: null, sdkSessionId: null,
    }));
  });
});
