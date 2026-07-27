import { describe, expect, it, vi } from 'vitest';

import {
  applyPendingAgentSwitchIfIdle,
  applySetModelThenCancelAgentSwitchIntent,
  performSessionAgentSwitch,
  registerMakerSessionAgentSwitchHandler,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
} from '../sessionAgentSwitchHandler';
import { MAKER_INVOKE } from '../channels';
import { IpcHarness } from './helpers/ipcHarness';

function makeRow(overrides: Partial<AgentSwitchSessionRow> = {}): AgentSwitchSessionRow {
  return {
    id: 's1',
    agentKind: 'cc',
    model: 'claude-fable-5',
    status: 'active',
    remoteHostId: null,
    orcaRole: null,
    sdkSessionId: 'sdk-old',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}): {
  deps: MakerSessionAgentSwitchHandlerDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: MakerSessionAgentSwitchHandlerDeps = {
    getSessionRow: vi.fn(async () => makeRow()),
    getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    closeSession: vi.fn(async () => {
      calls.push('close');
    }),
    listMessagesForHandoff: vi.fn(async () => [
      { role: 'user', content: '你好', createdAt: 1 },
      { role: 'assistant', content: '你好!', createdAt: 2 },
    ]),
    applyAgentSwitchToDb: vi.fn(async () => {
      calls.push('db');
    }),
    setSessionProvider: vi.fn(() => {
      calls.push('provider');
    }),
    insertBoundaryMessage: vi.fn(async () => {
      calls.push('boundary');
      return 'boundary-client-1';
    }),
    applyResumeFallbackAtomically: vi.fn(async () => {
      calls.push('fallback-db');
    }),
    setPendingHandoff: vi.fn(() => {
      calls.push('pending');
    }),
    bootstrapSwitchedSession: vi.fn(async () => {
      calls.push('bootstrap');
    }),
    withCloseSuppressed: vi.fn((_sessionId, fn) => fn()),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, calls };
}

const validParams = {
  sessionId: 's1',
  targetAgentKind: 'codex',
  model: 'gpt-5.5',
  providerId: null,
};

describe('performSessionAgentSwitch', () => {
  it('happy path:close → DB 提交 → 边界行 → pending → bootstrap,顺序正确', async () => {
    const { deps, calls } = makeDeps();
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toEqual({ switched: true, agentKind: 'codex', model: 'gpt-5.5', engineReady: true });
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending', 'bootstrap']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      sdkSessionId: null,
    });
    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', null);
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('cc');
    expect(boundary.toAgentKind).toBe('codex');
    expect(boundary.fromModel).toBe('claude-fable-5');
    expect(boundary.toModel).toBe('gpt-5.5');
    expect(boundary.fromSdkSessionId).toBe('sdk-old');
    expect(boundary.resumed).toBe(false);
    expect(boundary.consumed).toBe(false);
    expect(boundary.handoff).toContain('Claude Code');
    // close→bootstrap 全程在抑制窗口内(切换的瞬态 close 不得触发 worktree 回收)
    expect(deps.withCloseSuppressed).toHaveBeenCalledTimes(1);
  });

  it('codex → claude-code 方向同样工作', async () => {
    const { deps } = makeDeps({
      getSessionRow: vi.fn(async () => makeRow({ agentKind: 'codex', model: 'gpt-5.5' })),
    });
    const result = await performSessionAgentSwitch(deps, {
      sessionId: 's1',
      targetAgentKind: 'claude-code',
      model: 'claude-fable-5',
    });
    expect(result.switched).toBe(true);
    expect(deps.setSessionProvider).not.toHaveBeenCalled();
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.fromAgentKind).toBe('codex');
    expect(boundary.toAgentKind).toBe('cc');
  });

  it('跨引擎 DB 提交后立即覆盖旧 provider route', async () => {
    const { deps } = makeDeps();

    await performSessionAgentSwitch(deps, {
      ...validParams,
      providerId: 'anthropic',
    });

    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', 'anthropic');
    expect(vi.mocked(deps.applyAgentSwitchToDb).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.setSessionProvider).mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['空白值', '  ', null],
    ['首尾空格', ' anthropic ', 'anthropic'],
  ])('%s providerId 在 DB 与内存路由中使用同一归一化值', async (_case, providerId, expected) => {
    const { deps } = makeDeps();

    await performSessionAgentSwitch(deps, {
      ...validParams,
      providerId,
    });

    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ providerId: expected }),
    );
    expect(deps.setSessionProvider).toHaveBeenCalledWith('s1', expected);
  });

  it('参数校验:非法 sessionId / targetAgentKind / model 抛 INVALID_PARAMS', async () => {
    const { deps } = makeDeps();
    await expect(performSessionAgentSwitch(deps, { ...validParams, sessionId: 7 })).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'gemini' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(performSessionAgentSwitch(deps, { ...validParams, model: '' })).rejects.toThrow(/INVALID_PARAMS/);
  });

  it('会话不存在或已删除抛 NOT_FOUND', async () => {
    const missing = makeDeps({ getSessionRow: vi.fn(async () => null) });
    await expect(performSessionAgentSwitch(missing.deps, validParams)).rejects.toThrow(/NOT_FOUND/);
    const deleted = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ status: 'deleted' })) });
    await expect(performSessionAgentSwitch(deleted.deps, validParams)).rejects.toThrow(/NOT_FOUND/);
  });

  it('远程会话与 Orca 会话抛 UNSUPPORTED_CAPABILITY', async () => {
    const remote = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ remoteHostId: 'host-1' })) });
    await expect(performSessionAgentSwitch(remote.deps, validParams)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    const orca = makeDeps({ getSessionRow: vi.fn(async () => makeRow({ orcaRole: 'lead' })) });
    await expect(performSessionAgentSwitch(orca.deps, validParams)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
  });

  it('同引擎目标 = no-op 成功,不发生任何状态变更', async () => {
    const { deps, calls } = makeDeps();
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-5',
    });
    expect(result.switched).toBe(false);
    expect(calls).toEqual([]);
  });

  it('turn 进行中抛 SESSION_RUNNING,不触碰任何状态', async () => {
    const { deps, calls } = makeDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow(/SESSION_RUNNING/);
    expect(calls).toEqual([]);
  });

  it('无 live session 时跳过 close,其余照常', async () => {
    const { deps, calls } = makeDeps({ getLiveSession: vi.fn(() => null) });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result.switched).toBe(true);
    expect(calls).toEqual(['db', 'provider', 'boundary', 'pending', 'bootstrap']);
  });

  it('边界行插入失败降级:仍设 pending 并 bootstrap,返回成功', async () => {
    const { deps, calls } = makeDeps({
      insertBoundaryMessage: vi.fn(async () => {
        throw new Error('db write failed');
      }),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result.switched).toBe(true);
    expect(calls).toEqual(['close', 'db', 'provider', 'pending', 'bootstrap']);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('bootstrap 失败返回 engineReady=false(切换已提交,下一条消息 lazy-create 重试)', async () => {
    const { deps } = makeDeps({
      bootstrapSwitchedSession: vi.fn(async () => {
        throw new Error('spawn failed');
      }),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(deps.setPendingHandoff).toHaveBeenCalled();
  });

  it('DB 提交失败原样抛出,不插边界行、不设 pending', async () => {
    const { deps, calls } = makeDeps({
      applyAgentSwitchToDb: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    await expect(performSessionAgentSwitch(deps, validParams)).rejects.toThrow('db locked');
    expect(calls).toEqual(['close']);
    expect(deps.setSessionProvider).not.toHaveBeenCalled();
  });
});

describe('deferred switch (turn running)', () => {
  function makeDepsWithPending(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    const base = makeDeps(overrides);
    const store = new Map<
      string,
      {
        targetAgentKind: 'claude-code' | 'codex';
        model: string;
        providerId: string | null | undefined;
        effort?: string;
        fastMode?: boolean;
      }
    >();
    base.deps.pendingSwitches = {
      set: (id, intent) => void store.set(id, intent),
      get: (id) => store.get(id),
      clear: (id) => void store.delete(id),
    };
    return { ...base, store };
  }

  it('turn 运行中登记 pending 并返回 deferred,不触碰任何状态', async () => {
    const { deps, calls, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: false, deferred: true, agentKind: 'codex', model: 'gpt-5.5' });
    expect(calls).toEqual([]);
    expect(store.get('s1')).toEqual({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
  });

  it('意图制:空闲时外部调用同样只登记意图(不关引擎/不建交接/不插边界行)', async () => {
    const onPendingSwitchChanged = vi.fn();
    const { deps, calls, store } = makeDepsWithPending({ onPendingSwitchChanged });
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      effort: 'xhigh',
      fastMode: true,
    });
    expect(result).toMatchObject({ switched: false, deferred: true });
    expect(calls).toEqual([]);
    expect(deps.listMessagesForHandoff).not.toHaveBeenCalled();
    expect(store.get('s1')).toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'xhigh',
      fastMode: true,
    });
    expect(onPendingSwitchChanged).toHaveBeenCalledWith('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'xhigh',
      fastMode: true,
    });
  });

  it('跨引擎意图淘汰较早的 pending credential switch', async () => {
    const supersedePendingCredentialSwitch = vi.fn();
    const { deps, store } = makeDepsWithPending({ supersedePendingCredentialSwitch });

    await performSessionAgentSwitch(deps, validParams);

    expect(supersedePendingCredentialSwitch).toHaveBeenCalledWith('s1');
    expect(store.get('s1')).toMatchObject({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
    });
  });

  it('意图制:反复改选只覆盖意图,applyNow 才执行真切换', async () => {
    const { deps, calls, store } = makeDepsWithPending();
    await performSessionAgentSwitch(deps, validParams);
    await performSessionAgentSwitch(deps, { ...validParams, model: 'gpt-5.5-codex' });
    expect(calls).toEqual([]);
    expect(store.get('s1')).toMatchObject({ model: 'gpt-5.5-codex' });
    const result = await performSessionAgentSwitch(deps, {
      ...validParams,
      model: 'gpt-5.5-codex',
      applyNow: true,
      skipBootstrap: true,
    });
    expect(result).toMatchObject({ switched: true });
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
  });

  it('意图制:effort/fastMode 经意图透传到 applyAgentSwitchToDb', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
      effort: 'high',
      fastMode: true,
    });
  });

  it('同引擎 no-op 清除已登记的 pending(用户改主意)', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await performSessionAgentSwitch(deps, { ...validParams, targetAgentKind: 'claude-code', model: 'claude-sonnet-5' });
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:空闲时清 pending 并执行切换(skipBootstrap)', async () => {
    const onPendingSwitchChanged = vi.fn();
    const { deps, calls, store } = makeDepsWithPending({ onPendingSwitchChanged });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(false);
    // skipBootstrap:不含 'bootstrap'
    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      sdkSessionId: null,
    });
    expect(onPendingSwitchChanged).toHaveBeenLastCalledWith('s1', null);
  });

  it('只读查询返回公开 intent 投影，不泄露 resume recovery payload', async () => {
    const store = new Map<string, PendingAgentSwitchIntent>();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
      resumeFallbackRecovery: {
        boundaryClientId: 'boundary-1',
        boundaryContent: {
          fromAgentKind: 'cc',
          toAgentKind: 'codex',
          fromModel: 'claude-fable-5',
          toModel: 'gpt-5.5',
          fromSdkSessionId: 'sdk-old',
          handoff: 'private recovery handoff',
        },
        handoff: 'private recovery handoff',
      },
    });
    const { deps } = makeDeps({
      pendingSwitches: {
        set: (id, intent) => void store.set(id, intent),
        get: (id) => store.get(id),
        clear: (id) => void store.delete(id),
      },
    });
    const ipc = new IpcHarness();
    registerMakerSessionAgentSwitchHandler(ipc, deps);

    await expect(ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, 's1')).resolves.toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    });
    await expect(ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, '')).rejects.toThrow(/INVALID_PARAMS/);
  });

  it('applyPendingAgentSwitchIfIdle:直发路径可要求切换后同步 bootstrap', async () => {
    const { deps, store } = makeDepsWithPending();
    store.set('s1', {
      targetAgentKind: 'codex',
      model: 'gpt-5.5-codex',
      providerId: null,
    });

    await applyPendingAgentSwitchIfIdle(deps, 's1', { bootstrapAfterSwitch: true });

    expect(deps.bootstrapSwitchedSession).toHaveBeenCalledWith('s1');
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:turn 仍在跑时保留 pending 本次不动', async () => {
    const { deps, calls, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('applyPendingAgentSwitchIfIdle:无 pending 时 no-op', async () => {
    const { deps, calls } = makeDepsWithPending();
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(calls).toEqual([]);
  });

  it('applyPendingAgentSwitchIfIdle:执行失败吞掉不抛(不阻塞发送),pending 保留供下次重试', async () => {
    const { deps, store } = makeDepsWithPending({
      applyAgentSwitchToDb: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).resolves.toBeUndefined();
    expect(store.has('s1')).toBe(true);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('applyPendingAgentSwitchIfIdle:同 session 并发调用复用同一 in-flight,只执行一次切换', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, store } = makeDepsWithPending({
      applyAgentSwitchToDb: vi.fn(async () => gate),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    const first = applyPendingAgentSwitchIfIdle(deps, 's1');
    const second = applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledTimes(1);
    expect(store.has('s1')).toBe(false);
  });

  it('applyPendingAgentSwitchIfIdle:pre-check 后 running 竞态失败仍保留 intent', async () => {
    let reads = 0;
    const { deps, store } = makeDepsWithPending({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => ++reads > 1 })),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.has('s1')).toBe(true);
    expect(deps.applyAgentSwitchToDb).not.toHaveBeenCalled();
  });
  it('applyPendingAgentSwitchIfIdle completes the switch when abort arrives during close', async () => {
    const controller = new AbortController();
    const { deps, store, calls } = makeDepsWithPending({
      closeSession: vi.fn(async () => {
        calls.push('close');
        controller.abort();
      }),
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });

    await applyPendingAgentSwitchIfIdle(deps, 's1', { signal: controller.signal });

    expect(calls).toEqual(['close', 'db', 'provider', 'boundary', 'pending']);
    expect(store.has('s1')).toBe(false);
  });
});

describe('SET_MODEL cancels agent switch intent only after success', () => {
  it('成功后清 main intent 并广播 renderer rollback', async () => {
    const registry = {
      set: vi.fn(),
      get: vi.fn(),
      clear: vi.fn(),
    };
    const broadcast = vi.fn();
    await expect(applySetModelThenCancelAgentSwitchIntent(
      registry,
      's1',
      async () => 'ok',
      broadcast,
    )).resolves.toBe('ok');
    expect(registry.clear).toHaveBeenCalledWith('s1');
    expect(broadcast).toHaveBeenCalledWith('s1');
  });

  it('SET_MODEL 失败时 main intent 与 renderer 乐观态都保留', async () => {
    const registry = {
      set: vi.fn(),
      get: vi.fn(),
      clear: vi.fn(),
    };
    const broadcast = vi.fn();
    await expect(applySetModelThenCancelAgentSwitchIntent(
      registry,
      's1',
      async () => { throw new Error('set model failed'); },
      broadcast,
    )).rejects.toThrow('set model failed');
    expect(registry.clear).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('Phase 2:切回停泊引擎(resume + 增量交接)', () => {
  const parked = { sdkSessionId: 'sdk-parked-codex', watermarkCreatedAt: 100, watermarkRowid: 7 };

  function makeResumeDeps(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    return makeDeps({
      findParkedEngineSession: vi.fn(async () => parked),
      listMessagesForHandoff: vi.fn(async (_sessionId: string, after?: { createdAt: number; rowid: number }) =>
        after
          ? [{ role: 'user', content: '离开期间的问题', createdAt: 200 }]
          : [
              { role: 'user', content: '最早的问题', createdAt: 1 },
              { role: 'tool_use', content: { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }, createdAt: 2 },
              { role: 'user', content: '离开期间的问题', createdAt: 200 },
            ],
      ),
      ...overrides,
    });
  }

  it('有停泊绑定:DB 落停泊 id、交接为增量模式、边界行标 resumed', async () => {
    const { deps } = makeResumeDeps();
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: true });
    expect(deps.findParkedEngineSession).toHaveBeenCalledWith('s1', 'codex');
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith('s1', {
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      sdkSessionId: 'sdk-parked-codex',
    });
    // 增量素材按水位线取
    expect(deps.listMessagesForHandoff).toHaveBeenCalledWith('s1', {
      createdAt: 100,
      rowid: 7,
    });
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.resumed).toBe(true);
    // 增量 framing(归位续接),且工作状态区来自全量历史
    expect(boundary.handoff).toContain('切回由你继续');
    expect(boundary.handoff).toContain('- /repo/a.ts');
    expect(boundary.handoff).not.toContain('最早的问题');
    expect(boundary.handoff).toContain('离开期间的问题');
  });

  it('无停泊绑定(查询返回 null):v1 全量行为不变', async () => {
    const { deps } = makeResumeDeps({ findParkedEngineSession: vi.fn(async () => null) });
    await performSessionAgentSwitch(deps, validParams);
    expect(deps.applyAgentSwitchToDb).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sdkSessionId: null }),
    );
    const boundary = vi.mocked(deps.insertBoundaryMessage).mock.calls[0][1];
    expect(boundary.resumed).toBe(false);
    expect(boundary.handoff).toContain('最早的问题');
  });

  it('resume 模式无视 skipBootstrap:pending-apply 路径也 eager spawn(回落窗口)', async () => {
    const { deps, calls } = makeResumeDeps();
    await performSessionAgentSwitch(deps, { ...validParams, skipBootstrap: true });
    expect(calls).toContain('bootstrap');
  });

  it('resume bootstrap 失败:清停泊 id → 边界行改写全量交接 → fresh 重试成功', async () => {
    const bootstrap = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('resume transcript missing'));
    const { deps } = makeResumeDeps({ bootstrapSwitchedSession: bootstrap });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: true });
    // 同一原子事务清掉失效 id并改写边界为全量交接 + resumed:false
    const rewritten = vi.mocked(deps.applyResumeFallbackAtomically).mock.calls[0];
    expect(rewritten[1]).toBe('boundary-client-1');
    expect(rewritten[2].resumed).toBe(false);
    expect(rewritten[2].handoff).toContain('最早的问题');
    // pending 最终是全量交接
    const lastPending = vi.mocked(deps.setPendingHandoff).mock.calls.at(-1)![1];
    expect(lastPending).toContain('最早的问题');
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it('resume 原子回落失败:不再重试 spawn,engineReady=false 并保留完整切换意图', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('resume transcript missing');
    });
    const store = new Map<string, Parameters<NonNullable<MakerSessionAgentSwitchHandlerDeps['pendingSwitches']>['set']>[1]>();
    const { deps } = makeResumeDeps({
      bootstrapSwitchedSession: bootstrap,
      applyResumeFallbackAtomically: vi.fn(async () => {
        throw new Error('db locked');
      }),
      pendingSwitches: {
        set: (id, intent) => void store.set(id, intent),
        get: (id) => store.get(id),
        clear: (id) => void store.delete(id),
      },
    });
    const result = await performSessionAgentSwitch(deps, { ...validParams, applyNow: true });
    expect(result).toMatchObject({ switched: true, engineReady: false, retryPending: true });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(store.get('s1')).toMatchObject({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      resumeFallbackRecovery: {
        boundaryClientId: 'boundary-client-1',
        boundaryContent: { resumed: false },
      },
    });
  });

  it('resume 原子回落失败后,下一次 send 自动重试恢复并清 intent', async () => {
    const store = new Map<string, Parameters<NonNullable<MakerSessionAgentSwitchHandlerDeps['pendingSwitches']>['set']>[1]>();
    const fallback = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('db temporarily locked'));
    const { deps } = makeResumeDeps({
      bootstrapSwitchedSession: vi.fn(async () => { throw new Error('parked session missing'); }),
      applyResumeFallbackAtomically: fallback,
      pendingSwitches: {
        set: (id, intent) => void store.set(id, intent),
        get: (id) => store.get(id),
        clear: (id) => void store.delete(id),
      },
    });
    store.set('s1', { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });

    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(store.get('s1')?.resumeFallbackRecovery).toBeDefined();
    await applyPendingAgentSwitchIfIdle(deps, 's1');

    expect(fallback).toHaveBeenCalledTimes(2);
    expect(store.has('s1')).toBe(false);
    expect(deps.setPendingHandoff).toHaveBeenLastCalledWith(
      's1',
      expect.stringContaining('最早的问题'),
    );
  });

  it('resume 两段 bootstrap 都失败:engineReady=false,pending 为全量交接', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const { deps } = makeResumeDeps({ bootstrapSwitchedSession: bootstrap });
    const result = await performSessionAgentSwitch(deps, validParams);
    expect(result).toMatchObject({ switched: true, engineReady: false });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    const lastPending = vi.mocked(deps.setPendingHandoff).mock.calls.at(-1)![1];
    expect(lastPending).toContain('最早的问题');
  });
});
