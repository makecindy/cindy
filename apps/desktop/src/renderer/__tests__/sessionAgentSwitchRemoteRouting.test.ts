/**
 * session-agent-switch 的 device-link 远程会话接线回归。
 *
 * 背景:同会话跨引擎切换(Claude Code ↔ Codex)的 channel 早已在 device-link allowlist 里
 * (手机版控制端在用),但桌面控制端一度把入口按 v1 限制关掉、切换 IPC 也硬打本机 maker —— 远程
 * 会话在被控端才有,打本机必失败。这里锁住三件事:
 *   1. 传输层按 session 来源路由(远程隧道 / 本机直连,args 与 preload 对齐);
 *   2. 意图镜像的归一化与幂等(权威态在会话所在端,控制端只做镜像);
 *   3. ChatInput 的入口门控不再排除 device-link,且切换走传输层。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const sess = (id: string): Session => ({ id }) as unknown as Session;

describe('makerApiFor 的 agent 切换路由', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function stubElectron() {
    const maker = {
      switchSessionAgent: vi.fn().mockResolvedValue({ deferred: true }),
      getSessionAgentSwitchIntent: vi.fn().mockResolvedValue(null),
    };
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('window', { electronAPI: { maker, deviceLink: { invoke } } });
    return { maker, invoke };
  }

  it('远程会话:登记 / 读回都命中被控端 channel(入参顺序与 preload 一致)', async () => {
    const { maker, invoke } = stubElectron();
    const { makerApiFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-1')]);

    const api = makerApiFor('remote-1');
    await api.switchSessionAgent('remote-1', 'codex', 'gpt-5.5', 'openai', 'high', true);
    await api.getSessionAgentSwitchIntent('remote-1');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:switch-session-agent', [
      'remote-1',
      'codex',
      'gpt-5.5',
      'openai',
      'high',
      true,
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-session-agent-switch-intent', [
      'remote-1',
    ]);
    // 远程会话在控制端本机不存在,绝不能打本机 maker。
    expect(maker.switchSessionAgent).not.toHaveBeenCalled();
    expect(maker.getSessionAgentSwitchIntent).not.toHaveBeenCalled();
  });

  it('本机会话:直连本机 maker,不经隧道(零回归)', async () => {
    const { maker, invoke } = stubElectron();
    const { makerApiFor } = await import('@/lib/makerTransport');

    const api = makerApiFor('local-1'); // 未注册进 remoteProjectsStore → 本机
    await api.switchSessionAgent('local-1', 'codex', 'gpt-5.5', 'openai', 'high', false);
    await api.getSessionAgentSwitchIntent('local-1');

    expect(maker.switchSessionAgent).toHaveBeenCalledWith(
      'local-1',
      'codex',
      'gpt-5.5',
      'openai',
      'high',
      false,
    );
    expect(maker.getSessionAgentSwitchIntent).toHaveBeenCalledWith('local-1');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('makerChatStore.mirrorAgentSwitchIntent', () => {
  // 模块级 sessions Map 跨用例持久 → 每个用例用唯一 sessionId 隔离。
  let n = 0;
  const sid = () => `agent-switch-mirror-${n++}`;

  it('wire 投影(targetAgentKind)收窄成展示记录(target),providerId 缺失按 null', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      fastMode: true,
    });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toEqual({
      target: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'high',
      fastMode: true,
    });
    // 展示槽独立:真实 reducer 路由不受影响。
    expect(makerChatStore.getSnapshot(s).agentKind).toBe('claude-code');
  });

  it('幂等:同值回声不重建快照(不与本端乐观登记打架)', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: 'openai' });
    const snap = makerChatStore.getSnapshot(s);
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
    });
    expect(makerChatStore.getSnapshot(s)).toBe(snap); // 引用不变 = 未触发更新
  });

  it('null / 非法值 = 无意图 → 清除', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    makerChatStore.mirrorAgentSwitchIntent(s, null);
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();

    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    makerChatStore.mirrorAgentSwitchIntent(s, { targetAgentKind: 'gemini', model: 'x' });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
  });

  it('sessions:patched 带 agentSwitchIntent 才镜像;不带该字段的普通 patch 不得清掉意图', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    // 被控端 / 另一窗口登记 → 回流镜像进控制端展示槽。
    makerChatStore.mirrorSessionFields(s, {
      agentSwitchIntent: { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' },
    });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent?.target).toBe('codex');

    // 标题 / preview 之类的无关广播不带该字段:意图必须原样保留。
    makerChatStore.mirrorSessionFields(s, { title: 'x' } as { fastMode?: unknown });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent?.target).toBe('codex');

    // 被控端清除意图(apply 完成 / 用户撤销)→ 显式 null 才清。
    makerChatStore.mirrorSessionFields(s, { agentSwitchIntent: null });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
  });
});

describe('isAgentSwitchResponseFresh（远程意图读回的新鲜度守卫）', () => {
  const base = {
    cancelled: false,
    writeSeqAtStart: 3,
    writeSeqNow: 3,
    intentRevAtStart: 7,
    intentRevNow: 7,
  };

  it('在途期间无人改动 → 应用读回结果', async () => {
    const { isAgentSwitchResponseFresh } = await import('@/components/new-chat/agentSwitchConfirmation');
    expect(isAgentSwitchResponseFresh(base)).toBe(true);
  });

  it('effect 已清理(切走会话)→ 丢弃', async () => {
    const { isAgentSwitchResponseFresh } = await import('@/components/new-chat/agentSwitchConfirmation');
    expect(isAgentSwitchResponseFresh({ ...base, cancelled: true })).toBe(false);
  });

  it('本端 ABA:点选登记后又撤销 → 写序号已变,丢弃', async () => {
    const { isAgentSwitchResponseFresh } = await import('@/components/new-chat/agentSwitchConfirmation');
    expect(isAgentSwitchResponseFresh({ ...base, writeSeqNow: 5 })).toBe(false);
  });

  it('外部 ABA:另一窗口 / 被控端把意图改成非空又清回 null → 修订号已变,丢弃', async () => {
    const { isAgentSwitchResponseFresh } = await import('@/components/new-chat/agentSwitchConfirmation');
    // 外部回流不经本端点选,writeSeq 不动;值也回到发起时的 null —— 只有修订号能识别。
    expect(
      isAgentSwitchResponseFresh({ ...base, writeSeqNow: 3, intentRevNow: 9 }),
    ).toBe(false);
  });
});

describe('resolveAgentSwitchAckAction（ack 分派：两类守卫作用域不同）', () => {
  const fresh = {
    cancelled: false,
    writeSeqAtStart: 3,
    writeSeqNow: 3,
    intentRevAtStart: 7,
    intentRevNow: 7,
  };
  const load = () => import('@/components/new-chat/agentSwitchConfirmation');

  it('deferred 常态 → 登记乐观意图', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    expect(
      resolveAgentSwitchAckAction({
        deferred: true,
        switched: false,
        intentNowIsEmpty: true,
        freshness: fresh,
      }),
    ).toBe('apply-intent');
  });

  it('回归:已有跨引擎意图 → 选回当前引擎模型 → 清除回流先到,仍须走同引擎重选', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 被控端处理同引擎 no-op 时会清 pending 意图并广播,回流推进修订号 —— 那是本次调用
    // 自己引起的,不是被外部超车。误判成 stale 会让用户刚选的模型不生效。
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: false,
        intentNowIsEmpty: true, // 清除回流已到:当前无意图 = 本次 no-op 的预期终态
        freshness: { ...fresh, intentRevNow: 9 },
      }),
    ).toBe('same-engine-reselect');
  });

  it('回归:同引擎重选在途时外部登记了**新**跨引擎意图 → 丢弃,不能 clear 掉更新的镜像', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 修订号同样变了,但回流后的内容是「有意图」——只可能来自更新的登记。继续收尾会把它
    // 抹掉,选择器退回旧引擎,而被控端下一条消息仍按新意图切换。
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: false,
        intentNowIsEmpty: false,
        freshness: { ...fresh, intentRevNow: 9 },
      }),
    ).toBe('discard');
  });

  it('用户又点了一次(写序号变)→ 所有分支一律作废,包括同引擎重选', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    for (const branch of [
      { deferred: true, switched: false },
      { deferred: false, switched: false },
      { deferred: false, switched: true },
    ]) {
      expect(
        resolveAgentSwitchAckAction({
          ...branch,
          intentNowIsEmpty: true,
          freshness: { ...fresh, writeSeqNow: 4 },
        }),
      ).toBe('discard');
    }
  });

  it('外部权威更新抢先 → 写意图值的分支仍然丢弃(不回退 stale-ack 防护)', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    const superseded = { ...fresh, intentRevNow: 9 };
    expect(
      resolveAgentSwitchAckAction({
        deferred: true,
        switched: false,
        intentNowIsEmpty: false,
        freshness: superseded,
      }),
    ).toBe('discard');
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: true,
        intentNowIsEmpty: false,
        freshness: superseded,
      }),
    ).toBe('discard');
  });

  it('立即切换路径无人超车 → 收敛真实引擎', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: true,
        intentNowIsEmpty: true,
        freshness: fresh,
      }),
    ).toBe('apply-switched');
  });
});

describe('agentSwitchCoordinator（串行链与写序号按 session，跨组件实例存活）', () => {
  const load = async () => {
    const mod = await import('@/components/new-chat/agentSwitchCoordinator');
    mod.__resetAgentSwitchCoordinatorForTests();
    return mod;
  };
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('同 session 串行:后一次点选必须等前一次往返结束才发出', async () => {
    const { runAgentSwitchExclusive } = await load();
    const first = deferred<string>();
    const started: string[] = [];

    const a = runAgentSwitchExclusive('s1', () => {
      started.push('a');
      return first.promise;
    });
    const b = runAgentSwitchExclusive('s1', () => {
      started.push('b');
      return Promise.resolve('b');
    });

    await Promise.resolve();
    expect(started).toEqual(['a']); // b 尚未发出
    first.resolve('a');
    await Promise.all([a, b]);
    expect(started).toEqual(['a', 'b']); // 发送顺序 = 点选顺序
  });

  it('不同 session 各自独立:A 的慢请求不拖住 B', async () => {
    const { runAgentSwitchExclusive } = await load();
    const slow = deferred<string>();
    const started: string[] = [];

    void runAgentSwitchExclusive('s1', () => {
      started.push('s1');
      return slow.promise;
    });
    await runAgentSwitchExclusive('s2', () => {
      started.push('s2');
      return Promise.resolve('s2');
    });

    expect(started).toEqual(['s1', 's2']);
    slow.resolve('done');
  });

  it('前一个任务失败不掐断链:后一个仍会发出', async () => {
    const { runAgentSwitchExclusive } = await load();
    const started: string[] = [];
    const failed = runAgentSwitchExclusive('s1', () => {
      started.push('a');
      return Promise.reject(new Error('tunnel down'));
    });
    await expect(failed).rejects.toThrow('tunnel down');
    await runAgentSwitchExclusive('s1', () => {
      started.push('b');
      return Promise.resolve('b');
    });
    expect(started).toEqual(['a', 'b']);
  });

  it('回归:写序号按 session 存在模块级,组件卸载重挂后不归零', async () => {
    const { nextAgentSwitchWriteSeq, getAgentSwitchWriteSeq } = await load();
    expect(nextAgentSwitchWriteSeq('s1')).toBe(1);
    expect(nextAgentSwitchWriteSeq('s1')).toBe(2);
    // 组件重挂 = 重新读取,而不是从 0 开始 —— 否则在途 ack 会被误判成新鲜。
    expect(getAgentSwitchWriteSeq('s1')).toBe(2);
    expect(getAgentSwitchWriteSeq('s2')).toBe(0); // 每个 session 独立计数
  });

  it('回归:同一 session 的队列跨「组件实例」共享,切走再切回不会分叉出并发', async () => {
    const { runAgentSwitchExclusive } = await load();
    const inFlight = deferred<string>();
    const started: string[] = [];

    // 旧组件发出请求后卸载(invoke 仍在飞)。
    void runAgentSwitchExclusive('s1', () => {
      started.push('old-mount');
      return inFlight.promise;
    });
    await Promise.resolve();
    // 新组件挂载后立即点选:必须排在在途请求之后,而不是另起一条空队列并发发送。
    const next = runAgentSwitchExclusive('s1', () => {
      started.push('new-mount');
      return Promise.resolve('ok');
    });
    await Promise.resolve();
    expect(started).toEqual(['old-mount']);
    inFlight.resolve('done');
    await next;
    expect(started).toEqual(['old-mount', 'new-mount']);
  });

  it('dispose 释放该 session 的协调状态', async () => {
    const { nextAgentSwitchWriteSeq, getAgentSwitchWriteSeq, disposeAgentSwitchSession } =
      await load();
    nextAgentSwitchWriteSeq('s1');
    disposeAgentSwitchSession('s1');
    expect(getAgentSwitchWriteSeq('s1')).toBe(0);
  });
});

describe('makerChatStore 意图修订号（ABA 识别的真源）', () => {
  let n = 0;
  const sid = () => `agent-switch-rev-${n++}`;

  it('任何来源的实际变更都推进修订号:本端登记 / 撤销 / 外部回流镜像', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    expect(makerChatStore.getAgentSwitchIntentRev(s)).toBe(0);

    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    const afterNote = makerChatStore.getAgentSwitchIntentRev(s);
    expect(afterNote).toBeGreaterThan(0);

    makerChatStore.clearAgentSwitchIntent(s);
    const afterClear = makerChatStore.getAgentSwitchIntentRev(s);
    // 值回到 null(与登记前相同),修订号必须继续前进 —— 这正是 ABA 能被识别的原因。
    expect(makerChatStore.getAgentSwitchIntent(s)).toBeNull();
    expect(afterClear).toBeGreaterThan(afterNote);

    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
    });
    expect(makerChatStore.getAgentSwitchIntentRev(s)).toBeGreaterThan(afterClear);
  });

  it('no-op(同值镜像 / 重复清空)不推进修订号,不误伤在途读回', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: 'openai' });
    const rev = makerChatStore.getAgentSwitchIntentRev(s);
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
    });
    expect(makerChatStore.getAgentSwitchIntentRev(s)).toBe(rev);

    makerChatStore.clearAgentSwitchIntent(s);
    const cleared = makerChatStore.getAgentSwitchIntentRev(s);
    makerChatStore.clearAgentSwitchIntent(s);
    expect(makerChatStore.getAgentSwitchIntentRev(s)).toBe(cleared);
  });
});

describe('ChatInput 的入口门控与调用路由', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('切换 IPC 走传输层(远程会话隧道到被控端),不再硬打本机 maker', () => {
    expect(source).toContain('switchApi.switchSessionAgent(');
    expect(source).toContain(': makerApiFor(sourceSessionId);');
    expect(source).not.toContain('window.electronAPI.maker.switchSessionAgent(');
  });

  it('入口按被控端能力位门控:device-link 不再被排除,SSH 远程仍排除', () => {
    expect(source).toContain(
      'sessionId && vendorKey && !remoteHostId && sessionAgentSwitchSupported',
    );
    expect(source).toContain('ccCaps.capabilities?.supportsSessionAgentSwitch === true');
    expect(source).toContain('codexCaps.capabilities?.supportsSessionAgentSwitch === true');
  });

  it('Orca 会话(lead / worker)排除:被控端 handler 对 orcaRole 一律拒,不能暴露必失败的入口', () => {
    expect(source).toContain('!sessionOrcaRole &&');
    // 会话视图必须把角色喂进来,否则门控恒为「非协同」。
    const viewSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/features/cc-agent/CCAgentSessionView.tsx'),
      'utf8',
    );
    expect(viewSource).toContain('sessionOrcaRole={session?.orcaRole ?? null}');
  });

  it('远程会话打开时读回被控端权威意图,并经新鲜度守卫过滤过期响应', () => {
    expect(source).toContain('.getSessionAgentSwitchIntent(sessionId)');
    expect(source).toContain('isAgentSwitchResponseFresh({');
    expect(source).toContain('makerChatStore.mirrorAgentSwitchIntent(sessionId, remoteIntent)');
    // 每次点选都要推进写序号,外部变更靠 store 修订号 —— 少任一个 ABA 守卫都失效。
    expect(source).toContain('nextAgentSwitchWriteSeq(sourceSessionId)');
    expect(source).toContain('makerChatStore.getAgentSwitchIntentRev(sessionId)');
    // deviceId 跨重连不变,不把重连代际放进依赖就永远不会重试(断链期间的读回失败
    // 与错过的 sessions:patched 都靠这一跳补回)。
    expect(source).toContain(
      '}, [sessionId, deviceLinkDeviceId, remoteHostId, remoteReconnectEpoch]);',
    );
    expect(source).toContain("remoteConnStatus === 'connected'");
  });

  it('切换 ack 走分派决策:发起时捕获写序号与修订号,按分支判定而非一刀切 return', () => {
    expect(source).toContain('const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);');
    expect(source).toContain(
      'const intentRevAtSend = makerChatStore.getAgentSwitchIntentRev(sourceSessionId);',
    );
    expect(source).toContain('const ackAction = resolveAgentSwitchAckAction({');
    expect(source).toContain("if (ackAction === 'discard') return;");
    expect(source).toContain("if (ackAction === 'same-engine-reselect') {");
    expect(source).toContain(
      'intentNowIsEmpty: makerChatStore.getAgentSwitchIntent(sourceSessionId) === null,',
    );
  });

  it('切换写入走模块级协调层(串行链与写序号按 session,不随组件卸载归零)', () => {
    expect(source).toContain('const result = await runAgentSwitchExclusive(sourceSessionId, () =>');
    expect(source).toContain('const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);');
    expect(source).toContain('writeSeqNow: getAgentSwitchWriteSeq(sourceSessionId),');
    // 组件内不得再持有队列/序号 ref,否则重挂后又会分叉出第二条空队列。
    expect(source).not.toContain('agentSwitchWriteSeqRef');
    expect(source).not.toContain('agentSwitchQueueRef');
  });

  it('同引擎重选也进串行链:它的 SET_MODEL 在被控端会无条件清 pending intent', () => {
    // fire-and-forget 时这条慢请求可能在用户随后登记的新跨引擎意图之后才落地,把它清掉。
    expect(source).toContain('void runAgentSwitchExclusive(sourceSessionId, async () => {');
    expect(source).toContain(
      'if (providerId) await sameEngineReselectRef.current.byProvider(providerId, newModelId);',
    );
  });

  it('远程分支用稳定 deviceId 直连隧道:relay 瞬时重连会清空 sessionId→deviceId 索引', () => {
    expect(source).toContain('const switchApi = deviceLinkDeviceId');
    expect(source).toContain('? makerApiForDevice(deviceLinkDeviceId)');
    expect(source).toContain(': makerApiFor(sourceSessionId);');
  });

  it('await 返回后做会话作用域校验:旧会话响应不得借最新 ref 写进当前会话', () => {
    expect(source).toContain(
      'if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return;',
    );
    // 读回同理:往返期间被切走就丢弃。
    expect(source).toContain(
      'cancelled: cancelled || !isSessionScopeCurrent(sessionId, currentSessionIdRef.current),',
    );
  });
});
