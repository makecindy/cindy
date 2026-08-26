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
import { resolveManualCompactChannel } from '@/hooks/useAgentCapabilities';
import { createSessionScopedRequestGuard } from '@/features/cc-agent/sessionScopedRequestGuard';

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
    const { isAgentSwitchResponseFresh } =
      await import('@/components/new-chat/agentSwitchConfirmation');
    expect(isAgentSwitchResponseFresh(base)).toBe(true);
  });

  it('effect 已清理(切走会话)→ 丢弃', async () => {
    const { isAgentSwitchResponseFresh } =
      await import('@/components/new-chat/agentSwitchConfirmation');
    expect(isAgentSwitchResponseFresh({ ...base, cancelled: true })).toBe(false);
  });

  it('本端 ABA:点选登记后又撤销 → 写序号已变,丢弃', async () => {
    const { isAgentSwitchResponseFresh } =
      await import('@/components/new-chat/agentSwitchConfirmation');
    expect(isAgentSwitchResponseFresh({ ...base, writeSeqNow: 5 })).toBe(false);
  });

  it('外部 ABA:另一窗口 / 被控端把意图改成非空又清回 null → 修订号已变,丢弃', async () => {
    const { isAgentSwitchResponseFresh } =
      await import('@/components/new-chat/agentSwitchConfirmation');
    // 外部回流不经本端点选,writeSeq 不动;值也回到发起时的 null —— 只有修订号能识别。
    expect(isAgentSwitchResponseFresh({ ...base, writeSeqNow: 3, intentRevNow: 9 })).toBe(false);
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
        freshness: fresh,
      }),
    ).toBe('apply-intent');
  });

  it('回归:deferred 登记的**自己的广播回声**推进了修订号 → 值仍匹配即照常登记意图', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // main 先广播 sessions:patched(带 intent)、后返回 invoke reply,push 处理必然先于 ack ——
    // 只看修订号的话,每一次正常登记都会被自己的回声判成 stale,于是乐观呈现 / 草稿同步 / 收藏
    // 锚点全不落,而 main 的 pendingSwitches 里意图还在,下一条消息照样切引擎
    // (Chris 2026-08-19 实测「会话内换引擎整条链都不生效」的主根因)。
    expect(
      resolveAgentSwitchAckAction({
        deferred: true,
        switched: false,
        registeredIntentMatchesCurrent: true,
        freshness: { ...fresh, intentRevNow: 9 },
      }),
    ).toBe('apply-intent');
  });

  it('外部只改同一意图的 effort / Fast / 两者:身份仍匹配 → 照走 apply-intent(权威值经 note-skip 保留)', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 身份判定刻意只比 target/model/provider,不比 effort/fastMode(main 会归一化后才投影)。
    // 另一控制端在本次往返期间「只改 effort」「只改 Fast」「两者均改」时,调用方算出的
    // registeredIntentMatchesCurrent 因此仍为 true —— 三种场景在 resolver 层同构:修订号已变
    // + 值匹配 → apply-intent。外部新值不被本端旧值覆盖由 ChatInput 的 note-skip 保证
    // (回声已匹配时不再 noteAgentSwitchIntent,store 保持权威快照;见同文件源码锁)。
    for (const scenario of ['只改 effort', '只改 Fast', '两者均改']) {
      expect(
        resolveAgentSwitchAckAction({
          deferred: true,
          switched: false,
          registeredIntentMatchesCurrent: true,
          freshness: { ...fresh, intentRevNow: 9 },
        }),
        scenario,
      ).toBe('apply-intent');
    }
  });

  it('deferred:修订号变且当前值**不是**本次登记的那一份 → 真被外部超车,丢弃', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    expect(
      resolveAgentSwitchAckAction({
        deferred: true,
        switched: false,
        registeredIntentMatchesCurrent: false,
        freshness: { ...fresh, intentRevNow: 9 },
      }),
    ).toBe('discard');
  });

  it('deferred:值匹配也压不过写序号守卫(用户又点了一次)', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 值相等只回答「当前权威值是不是我要的那一份」;「用户已点选、新的切换还在途」由写序号
    // 独立覆盖,两者不能互相顶替。
    expect(
      resolveAgentSwitchAckAction({
        deferred: true,
        switched: false,
        registeredIntentMatchesCurrent: true,
        freshness: { ...fresh, writeSeqNow: 4, intentRevNow: 9 },
      }),
    ).toBe('discard');
  });

  it('回归:已有跨引擎意图 → 选回当前引擎模型 → 清除回流先到,仍须走同引擎重选', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 被控端处理同引擎 no-op 时会清 pending 意图并广播,回流推进修订号 —— 那是本次调用
    // 自己引起的,不是被外部超车。误判成 stale 会让用户刚选的模型不生效。
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: false,
        sameEngineRevision: 8,
        freshness: { ...fresh, intentRevNow: 9 },
      }),
    ).toBe('same-engine-reselect');
  });

  it('回归:同引擎 no-op 的 ack 先于清除回流到达 → 旧镜像仍非空也须继续重选', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 修订号未变证明当前非空仍是发起前的旧 intent,不是外部新登记；不能依赖 null push
    // 必须抢在 ack 前到达，否则 device-link 的响应/事件调度顺序会随机吞掉用户重选。
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: false,
        sameEngineRevision: 8,
        freshness: fresh,
      }),
    ).toBe('same-engine-reselect');
  });

  it('旧 host 无 CAS token:仅修订号未变时兼容执行,任何回流变化都 fail-closed', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    expect(
      resolveAgentSwitchAckAction({ deferred: false, switched: false, freshness: fresh }),
    ).toBe('same-engine-reselect');
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: false,
        freshness: { ...fresh, intentRevNow: 9 },
      }),
    ).toBe('discard');
  });

  it('回归:同引擎重选在途时外部登记或 ABA → host CAS 标成 superseded,一律丢弃', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 修订号同样变了,但回流后的内容是「有意图」——只可能来自更新的登记。继续收尾会把它
    // 抹掉,选择器退回旧引擎,而被控端下一条消息仍按新意图切换。
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: false,
        sameEngineSuperseded: true,
        freshness: { ...fresh, intentRevNow: 10 },
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
          freshness: { ...fresh, writeSeqNow: 4 },
        }),
      ).toBe('discard');
    }
  });

  it('外部权威更新抢先 → 写意图值的分支仍然丢弃(不回退 stale-ack 防护)', async () => {
    const { resolveAgentSwitchAckAction } = await load();
    // 不传 registeredIntentMatchesCurrent = 调用方拿不到「当前值是不是本次登记那一份」的判据,
    // 此时修订号变化一律 fail-closed(2026-08-19 新增的回声出口是 opt-in,不放宽这条默认)。
    const superseded = { ...fresh, intentRevNow: 9 };
    expect(
      resolveAgentSwitchAckAction({
        deferred: true,
        switched: false,
        freshness: superseded,
      }),
    ).toBe('discard');
    expect(
      resolveAgentSwitchAckAction({
        deferred: false,
        switched: true,
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
        freshness: fresh,
      }),
    ).toBe('apply-switched');
  });
});

describe('isAgentSwitchEchoConfigConsistent(回声匹配后的完整配置一致性,2026-08-19 review P2 收口)', () => {
  const load = () => import('@/components/new-chat/agentSwitchConfirmation');

  it('非回声路径(authoritative=null)恒一致 —— 常规新鲜 ack 不受影响', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: null,
        requestedEffort: 'high',
        requestedFastMode: false,
      }),
    ).toBe(true);
  });

  it('权威快照与本端请求逐字相等 → 一致(本端自己的回声 / 重复回声)', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: { effort: 'high', fastMode: true },
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(true);
  });

  it('另一控制端只改 effort → 不一致(三元组匹配也不算完整成功)', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: { effort: 'low', fastMode: true },
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(false);
  });

  it('另一控制端只改 Fast → 不一致', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: { effort: 'high', fastMode: false },
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(false);
  });

  it('effort 与 Fast 均被改 → 不一致', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: { effort: 'low', fastMode: false },
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(false);
  });

  it('缺字段模型:权威快照没投影 effort / fastMode → 该维不可判,放行(不误伤无档位模型)', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    // main 的 projectPendingAgentSwitchIntent 只在有值时带上 effort / fastMode:不可调深度的
    // 模型与旧 host 的快照天然缺维。缺 ≠ 被改,判不一致会把这类模型的每次正常切换都判失败。
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: {},
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(true);
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: { fastMode: true },
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(true);
  });

  it('本端没指定 effort(空值)→ 跟随默认解析,main 归一化出什么都算本次意图', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    // 语义与 providerId 传 null 同族:没请求的维不构成「被改」。
    for (const requestedEffort of [undefined, '']) {
      expect(
        isAgentSwitchEchoConfigConsistent({
          authoritative: { effort: 'medium', fastMode: false },
          requestedEffort,
          requestedFastMode: false,
        }),
        `requestedEffort=${JSON.stringify(requestedEffort)}`,
      ).toBe(true);
    }
  });

  it('缺维放行与有维严判互不越界:effort 缺维 + Fast 被改 → 仍不一致', async () => {
    const { isAgentSwitchEchoConfigConsistent } = await load();
    expect(
      isAgentSwitchEchoConfigConsistent({
        authoritative: { fastMode: false },
        requestedEffort: 'high',
        requestedFastMode: true,
      }),
    ).toBe(false);
  });
});

describe('agentSwitchCoordinator（串行链与写序号按 session，跨组件实例存活）', () => {
  const load = async () => {
    const mod = await import('@/lib/agentSwitchCoordinator');
    mod.__resetAgentSwitchCoordinatorForTests();
    return mod;
  };
  const deferred = <T>() => {
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

  it('复合操作预占整条串行位置:release 前后续点选不能插进 ack 后收尾', async () => {
    const { reserveAgentSwitchExclusive, runAgentSwitchExclusive } = await load();
    const turn = reserveAgentSwitchExclusive('s1');
    const started: string[] = [];
    await turn.ready;
    const next = runAgentSwitchExclusive('s1', () => {
      started.push('next');
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(started).toEqual([]);
    turn.release();
    await next;
    expect(started).toEqual(['next']);
    turn.release(); // release 幂等。
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
    const {
      beginAgentSendDispatch,
      beginAgentSwitchOperation,
      nextAgentSwitchWriteSeq,
      getAgentSwitchWriteSeq,
      hasPendingAgentSendDispatch,
      hasPendingAgentSwitchOperation,
      disposeAgentSwitchSession,
    } = await load();
    nextAgentSwitchWriteSeq('s1');
    beginAgentSwitchOperation('s1');
    beginAgentSendDispatch('s1');
    disposeAgentSwitchSession('s1');
    expect(getAgentSwitchWriteSeq('s1')).toBe(0);
    expect(hasPendingAgentSwitchOperation('s1')).toBe(false);
    expect(hasPendingAgentSendDispatch('s1')).toBe(false);
  });

  it('完整切换 pending 按 session 计数并通知，最后一个操作完成后才放开发送', async () => {
    const {
      beginAgentSwitchOperation,
      hasPendingAgentSwitchOperation,
      subscribeAgentSwitchPending,
    } = await load();
    const notifications: boolean[] = [];
    const unsubscribe = subscribeAgentSwitchPending(() => {
      notifications.push(hasPendingAgentSwitchOperation('s1'));
    });
    const finishA = beginAgentSwitchOperation('s1');
    const finishB = beginAgentSwitchOperation('s1');
    beginAgentSwitchOperation('s2');

    expect(hasPendingAgentSwitchOperation('s1')).toBe(true);
    finishA();
    expect(hasPendingAgentSwitchOperation('s1')).toBe(true);
    finishA(); // 完成函数幂等，不误减另一个操作。
    expect(hasPendingAgentSwitchOperation('s1')).toBe(true);
    finishB();
    expect(hasPendingAgentSwitchOperation('s1')).toBe(false);
    expect(hasPendingAgentSwitchOperation('s2')).toBe(true);
    expect(notifications).toEqual([true, true, true, true, false]);
    unsubscribe();
  });

  it('完整发送 pending 按 session 计数，跨组件重挂可见且完成函数幂等', async () => {
    const { beginAgentSendDispatch, hasPendingAgentSendDispatch } = await load();
    const finishA = beginAgentSendDispatch('s1');
    const finishB = beginAgentSendDispatch('s1');

    // 新组件从同一模块级 registry 读取，不依赖旧组件实例的 ref/state。
    expect(hasPendingAgentSendDispatch('s1')).toBe(true);
    expect(hasPendingAgentSendDispatch('s2')).toBe(false);
    finishA();
    finishA();
    expect(hasPendingAgentSendDispatch('s1')).toBe(true);
    finishB();
    expect(hasPendingAgentSendDispatch('s1')).toBe(false);
  });

  it('发送检查与登记原子化:切换在途时拒绝,外层准备 token 与共享发送边界可嵌套', async () => {
    const { beginAgentSwitchOperation, hasPendingAgentSendDispatch, tryBeginAgentSendDispatch } =
      await load();
    const finishSwitch = beginAgentSwitchOperation('s1');
    expect(tryBeginAgentSendDispatch('s1')).toBeNull();
    expect(hasPendingAgentSendDispatch('s1')).toBe(false);

    finishSwitch();
    const finishPreparation = tryBeginAgentSendDispatch('s1');
    const finishSharedBoundary = tryBeginAgentSendDispatch('s1');
    expect(finishPreparation).not.toBeNull();
    expect(finishSharedBoundary).not.toBeNull();
    expect(hasPendingAgentSendDispatch('s1')).toBe(true);
    finishPreparation?.();
    expect(hasPendingAgentSendDispatch('s1')).toBe(true);
    finishSharedBoundary?.();
    expect(hasPendingAgentSendDispatch('s1')).toBe(false);
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

describe('makerChatStore 共享发送边界', () => {
  it('切换在途时消息、UI 续跑、错误重试与压缩都 fail-closed', async () => {
    const coordinator = await import('@/lib/agentSwitchCoordinator');
    coordinator.__resetAgentSwitchCoordinatorForTests();
    const finishSwitch = coordinator.beginAgentSwitchOperation('guarded-send');
    const { makerChatStore } = await import('@/lib/makerChatStore');

    await expect(
      makerChatStore.sendMessage(
        'guarded-send',
        'hello',
        'claude-sonnet-4-6',
        'medium',
        'default',
        '/tmp/workdir',
      ),
    ).resolves.toBe(false);
    await expect(
      makerChatStore.sendUiTrigger('guarded-send', '[UI_ACTION_TRIGGER] continue'),
    ).rejects.toThrow('Agent switch is still in progress');
    await expect(makerChatStore.retryLastError('guarded-send')).rejects.toThrow(
      'Agent switch is still in progress',
    );
    await expect(
      makerChatStore.compactSession(
        'guarded-send',
        'claude-sonnet-4-6',
        'medium',
        'default',
        '/tmp/workdir',
      ),
    ).resolves.toBe(false);
    expect(coordinator.hasPendingAgentSendDispatch('guarded-send')).toBe(false);
    finishSwitch();
  });

  it('错误重试先发时从历史查询开始占住发送 token，settle 后才允许切换', async () => {
    const coordinator = await import('@/lib/agentSwitchCoordinator');
    coordinator.__resetAgentSwitchCoordinatorForTests();
    let rejectRetry!: (reason: Error) => void;
    const retryLastError = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );
    vi.stubGlobal('window', {
      electronAPI: { maker: { input: { retryLastError } } },
    });
    const { makerChatStore } = await import('@/lib/makerChatStore');

    const retry = makerChatStore.retryLastError('retry-first');
    expect(retryLastError).toHaveBeenCalledWith('retry-first');
    expect(coordinator.hasPendingAgentSendDispatch('retry-first')).toBe(true);
    // ChatInput 的切换入口同步检查这个 registry；重试 main RPC 尚未入队也不能被越过。
    expect(coordinator.hasPendingAgentSwitchOperation('retry-first')).toBe(false);

    rejectRetry(new Error('retry failed'));
    await expect(retry).rejects.toThrow('retry failed');
    expect(coordinator.hasPendingAgentSendDispatch('retry-first')).toBe(false);
  });

  it('上下文压缩先发时从队列恢复开始占住发送 token，settle 后才允许切换', async () => {
    const coordinator = await import('@/lib/agentSwitchCoordinator');
    coordinator.__resetAgentSwitchCoordinatorForTests();
    let rejectCompact!: (reason: Error) => void;
    const compact = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCompact = reject;
        }),
    );
    vi.stubGlobal('window', { electronAPI: { maker: { input: { compact } } } });
    const { makerChatStore } = await import('@/lib/makerChatStore');

    const request = makerChatStore.compactSession(
      'compact-first',
      'claude-sonnet-4-6',
      'medium',
      'default',
      '/tmp/workdir',
    );
    expect(compact).toHaveBeenCalledOnce();
    expect(coordinator.hasPendingAgentSendDispatch('compact-first')).toBe(true);

    rejectCompact(new Error('compact failed'));
    await expect(request).resolves.toBe(false);
    expect(coordinator.hasPendingAgentSendDispatch('compact-first')).toBe(false);
  });
});

describe('ChatInput 的入口门控与调用路由', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const storeSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/lib/makerChatStore.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('切换 IPC 走传输层(远程会话隧道到被控端),不再硬打本机 maker', () => {
    expect(source).toContain('switchApi.switchSessionAgent(');
    expect(source).toContain(': makerApiFor(sourceSessionId);');
    expect(source).not.toContain('window.electronAPI.maker.switchSessionAgent(');
  });

  it('入口按被控端能力位门控:device-link 不再被排除,SSH 远程仍排除', () => {
    // 2026-08-12 统一模型选择器(M6):会话内换引擎有了两种形态,门禁必须**逐字一致** ——
    //   · 统一面板(现在的常态):sessionEngineFilter 提供跨引擎入口;
    //   · 旧两步分段(仅 device-link 老被控端 capabilities-only 降级时还会渲染):agentSwitch。
    // 任一处放松,SSH 远程或缺 CAS 能力的被控端就会露出一个必然失败的切换入口。
    expect(source).toContain(
      '!sessionId || !vendorKey || remoteHostId || !sessionAgentSwitchSupported',
    );
    expect(source).toMatch(
      /!unifiedPanelActive &&\s*\n\s*sessionId &&\s*\n\s*vendorKey &&\s*\n\s*!remoteHostId &&\s*\n\s*sessionAgentSwitchSupported/,
    );
    expect(source).toContain('ccCaps.capabilities?.supportsSessionAgentSwitch === true');
    expect(source).toContain('ccCaps.capabilities.supportsSessionAgentSwitchCas === true');
    expect(source).toContain('codexCaps.capabilities?.supportsSessionAgentSwitch === true');
    expect(source).toContain('codexCaps.capabilities.supportsSessionAgentSwitchCas === true');
    const hostSource = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    expect(hostSource).toContain('supportsSessionAgentSwitchCas: true');
  });

  it('lazy-create 从 DB 对齐原子模型选择的 effort 与 Fast,不复用旧排队快照', () => {
    const hostSource = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    const start = hostSource.indexOf('async function reconcileCreateOptsAgainstDb(');
    const end = hostSource.indexOf('const agentSwitchDeps:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = hostSource.slice(start, end);
    expect(body).toContain('effort: sessions.effort,');
    expect(body).toContain('fastMode: sessions.fastMode,');
    expect(body).toContain("co.effort = (row.effort ?? undefined) as CreateOpts['effort'];");
    expect(body).toContain('co.fastMode = !!row.fastMode;');
  });

  it('Orca 与角色未加载会话都 fail-closed:只有完整元数据确认非协同后开放入口', () => {
    expect(source).toContain('sessionOrcaRole === null &&');
    // 会话视图必须保留 undefined 未知态,不能在完整 session 回流前冒充「非协同」。
    const viewSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/features/cc-agent/CCAgentSessionView.tsx'),
      'utf8',
    );
    expect(viewSource).toContain(
      'sessionOrcaRole={session ? (session.orcaRole ?? null) : undefined}',
    );
  });

  it('本地与远程会话打开时都读回 main 权威意图,并经新鲜度守卫过滤过期响应', () => {
    expect(source).toContain('if (!sessionId || remoteHostId) return;');
    expect(source).toContain('const switchApi = deviceLinkDeviceId');
    expect(source).toContain('? makerApiForDevice(deviceLinkDeviceId)');
    expect(source).toContain(': makerApiFor(sessionId);');
    expect(source).toContain('.getSessionAgentSwitchIntent(sessionId)');
    expect(source).toContain('isAgentSwitchResponseFresh({');
    expect(source).toContain(
      'makerChatStore.mirrorAgentSwitchIntent(sessionId, authoritativeIntent)',
    );
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
    // `return false` = 「这次选择没落地」(见「切换事务返回真实结果」一条)。
    expect(source).toContain("if (ackAction === 'discard') return false;");
    expect(source).toContain("if (ackAction === 'same-engine-reselect') {");
    expect(source).toContain('sameEngineRevision: result.sameEngineRevision,');
    expect(source).toContain('sameEngineSuperseded: result.sameEngineSuperseded,');
  });

  it('切换写入走模块级协调层(串行链与写序号按 session,不随组件卸载归零)', () => {
    expect(source).toContain('const exclusiveTurn = reserveAgentSwitchExclusive(sourceSessionId);');
    expect(source).toContain('await exclusiveTurn.ready;');
    expect(source).toContain('exclusiveTurn.release();');
    expect(source).toContain('const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);');
    expect(source).toContain('writeSeqNow: getAgentSwitchWriteSeq(sourceSessionId),');
    // 组件内不得再持有队列/序号 ref,否则重挂后又会分叉出第二条空队列。
    expect(source).not.toContain('agentSwitchWriteSeqRef');
    expect(source).not.toContain('agentSwitchQueueRef');

    const selectorSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ModelSelector.tsx'),
      'utf8',
    );
    expect(selectorSource).not.toContain('agentSwitchQueueRef');
    expect(selectorSource).toContain(
      'void agentSwitch.onSwitch(targetAgentKind, targetModelId, targetProviderId);',
    );
  });

  it('同引擎重选与前置 invoke 共占一个串行位置，并在用最新 ref 前校验会话', () => {
    const reservation = source.indexOf(
      'const exclusiveTurn = reserveAgentSwitchExclusive(sourceSessionId);',
    );
    const invoke = source.indexOf(
      'const result = await switchApi.switchSessionAgent(',
      reservation,
    );
    const scopeGuard = source.indexOf(
      'if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return false;',
      invoke,
    );
    const reselect = source.indexOf('const applied = providerId', scopeGuard);
    const staleGuard = source.indexOf('if (applied === false) return false;', reselect);
    const release = source.indexOf('exclusiveTurn.release();', reselect);
    expect(reservation).toBeGreaterThanOrEqual(0);
    expect(invoke).toBeGreaterThan(reservation);
    expect(scopeGuard).toBeGreaterThan(invoke);
    expect(reselect).toBeGreaterThan(scopeGuard);
    expect(staleGuard).toBeGreaterThan(reselect);
    expect(release).toBeGreaterThan(reselect);
  });

  it('同引擎重选把 host 因果 token 带回 SET_MODEL，且遇到 superseded 不落后续状态', () => {
    expect(source).toContain('expectedAgentSwitchRevision?: number');
    expect(source).toContain('expectedAgentSwitchRevision === undefined &&');
    expect(source.split('expectedAgentSwitchRevision === undefined &&')).toHaveLength(3);
    expect(source).toContain('remoteAtomicModelSelectionSupported');
    expect(source).toContain(
      'expectedAgentSwitchRevision !== undefined || remoteAtomicModelSelectionSupported',
    );
    expect(source).toContain('? { effort: newEffort, fastMode: restoredFast }');
    expect(source).toContain('? { effort: targetEffort, fastMode: restoredFast }');
    expect(source).toContain('if (!useAtomicSelection) {');
    expect(source).toContain('if (remoteSetModelResult?.superseded) {');
    expect(source).toContain('if (setModelResult?.superseded) {');
    expect(source).toContain('result.sameEngineRevision,');
  });

  it('切换意图登记完成前所有发送入口都被同步门禁，组件重挂后 pending 仍可见', () => {
    expect(source).toContain('const agentSwitchInFlight = useSyncExternalStore(');
    expect(source).toContain('const finishAgentSwitchOperation = beginAgentSwitchOperation(');
    expect(source).toContain('finishAgentSwitchOperation();');
    expect(source).toContain('? tryBeginAgentSendDispatch(sourceSessionId)');
    expect(source).toContain('agentSwitchInFlight ||');

    // composer 之外的继续 / 编辑重发等入口最终都经过共享 store 边界，不能要求每个
    // UI 调用点记得手工登记 token。
    const sendMessage = storeSource.indexOf('function sendMessage(');
    const sendMessageBegin = storeSource.indexOf('return withAgentSendDispatch(', sendMessage);
    const sendUiTrigger = storeSource.indexOf('function sendUiTrigger(');
    const uiTriggerBegin = storeSource.indexOf('return withAgentSendDispatch(', sendUiTrigger);
    const retryLastError = storeSource.indexOf('function retryLastError(');
    const retryBegin = storeSource.indexOf(
      'return runAgentDispatchProjectionOperation(',
      retryLastError,
    );
    const compactSession = storeSource.indexOf('function compactSession(');
    const compactBegin = storeSource.indexOf(
      'return runAgentDispatchProjectionOperation(',
      compactSession,
    );
    const resumeQueue = storeSource.indexOf('function resumeQueue(');
    const resumeBegin = storeSource.indexOf('runAgentDispatchProjectionOperation(', resumeQueue);
    const steerMessage = storeSource.indexOf('function steerMessage(');
    const steerBegin = storeSource.indexOf('return withAgentSendDispatch(', steerMessage);
    const steerQueuedMessage = storeSource.indexOf('function steerQueuedMessage(');
    const queuedSteerBegin = storeSource.indexOf(
      'return withAgentSendDispatch(',
      steerQueuedMessage,
    );
    const resendBlockedMessage = storeSource.indexOf('async function resendBlockedMessage(');
    const blockedResendBegin = storeSource.indexOf(
      'const finishAgentSendDispatch = tryBeginAgentSendDispatch(sessionId);',
      resendBlockedMessage,
    );
    const sharedBegin = storeSource.indexOf(
      'const finishAgentSendDispatch = tryBeginAgentSendDispatch(sessionId);',
    );
    const sharedFinish = storeSource.indexOf(
      'return task().finally(finishAgentSendDispatch);',
      sharedBegin,
    );
    expect(sendMessageBegin).toBeGreaterThan(sendMessage);
    expect(uiTriggerBegin).toBeGreaterThan(sendUiTrigger);
    expect(retryBegin).toBeGreaterThan(retryLastError);
    expect(compactBegin).toBeGreaterThan(compactSession);
    expect(resumeBegin).toBeGreaterThan(resumeQueue);
    expect(steerBegin).toBeGreaterThan(steerMessage);
    expect(queuedSteerBegin).toBeGreaterThan(steerQueuedMessage);
    expect(blockedResendBegin).toBeGreaterThan(resendBlockedMessage);
    expect(sharedBegin).toBeGreaterThanOrEqual(0);
    expect(sharedFinish).toBeGreaterThan(sharedBegin);
  });

  it('引用水合期间发送与切换双向互斥，并在真正发送前复核切换状态', () => {
    const sendBegin = source.indexOf('tryBeginAgentSendDispatch(sourceSessionId)');
    const hydrate = source.indexOf('await resolveSessionMessageReferencesForSend(editor);');
    const sendRecheck = source.indexOf(
      'if (sourceSessionId && hasPendingAgentSwitchOperation(sourceSessionId)) return;',
      hydrate,
    );
    const onSend = source.indexOf('result = await onSend(', sendRecheck);
    const sendFinish = source.indexOf('finishAgentSendDispatch();', onSend);
    const sendSelfGuard = source.indexOf(
      'if (sessionId && hasPendingAgentSendDispatch(sessionId)) return;',
    );
    const switchGuard = source.indexOf(
      'if (hasPendingAgentSendDispatch(sessionId)) return false;',
      sendFinish,
    );

    expect(sendSelfGuard).toBeGreaterThanOrEqual(0);
    expect(sendBegin).toBeGreaterThan(sendSelfGuard);
    expect(hydrate).toBeGreaterThan(sendBegin);
    expect(sendRecheck).toBeGreaterThan(hydrate);
    expect(onSend).toBeGreaterThan(sendRecheck);
    expect(sendFinish).toBeGreaterThan(onSend);
    expect(switchGuard).toBeGreaterThan(sendFinish);
    expect(source).toContain(
      'disabled || settingsLocked || agentSendDispatchInFlight || agentSwitchInFlight',
    );
  });

  it('远程分支用稳定 deviceId 直连隧道:relay 瞬时重连会清空 sessionId→deviceId 索引', () => {
    expect(source).toContain('const switchApi = deviceLinkDeviceId');
    expect(source).toContain('? makerApiForDevice(deviceLinkDeviceId)');
    expect(source).toContain(': makerApiFor(sourceSessionId);');
  });

  it('远程只切模型沿用当前 provider,避免 JSON optional 占位清除来源', () => {
    const start = source.indexOf('const performModelChange = useCallback(');
    const end = source.indexOf('const handleModelChange = useCallback(', start);
    const body = source.slice(start, end);
    expect(body).toMatch(
      /remoteMaker\.setModel\(\s*sessionId,\s*newModelId,\s*selectedProviderId,\s*expectedAgentSwitchRevision,/,
    );
  });

  it('await 返回后做会话作用域校验:旧会话响应不得借最新 ref 写进当前会话', () => {
    // `return false` 而不是裸 return:见下一条 —— 这是「没把选择落到会话上」的出口之一。
    expect(source).toContain(
      'if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return false;',
    );
    // 读回同理:往返期间被切走就丢弃。
    expect(source).toContain(
      'cancelled: cancelled || !isSessionScopeCurrent(sessionId, currentSessionIdRef.current),',
    );
  });

  /**
   * 2026-08-17 review 第二项:`performAgentSwitch` 必须把**真实结果**交出去。
   *
   * 病根:统一面板的跨引擎链路(`sessionEngineFilter.onCrossEngineSelect`)此前
   * fire-and-forget 之后立即 `return true` —— 那个 true 只表示「确认框过了」。面板侧把
   * 「成功才做」的清理挂在它上面(恢复推荐清 override / 删除当前选中的收藏),于是
   * `switchSessionAgent` 抛错、或 pending send 把切换挡下时,用户的 override / 收藏已经
   * 被清掉,原配置无从恢复。
   *
   * 锁三件事:① 所有「没落地」的出口返 false;② 登记 / 应用成功的出口返 true;
   * ③ 跨引擎回调 await 并原样透传,不再自己造布尔。
   */
  it('切换事务返回真实结果:失败 / 被拒返 false,登记成功才返 true', () => {
    const start = source.indexOf('const performAgentSwitch = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(
      start,
      source.indexOf('const performAgentSwitchRef = useRef(', start),
    );
    // 签名显式声明 Promise<boolean> —— 返回值是契约的一部分,不靠推断。
    expect(body).toContain('): Promise<boolean> => {');
    // 「没落地」的四个出口:无会话 / pending send 拒绝 / 会话已切走 / ack 被超车。
    expect(body).toContain('if (!sessionId) return false;');
    expect(body).toContain('if (hasPendingAgentSendDispatch(sessionId)) return false;');
    expect(body).toContain("if (ackAction === 'discard') return false;");
    // 同引擎重选被修订号守卫拒下 = 没落地。
    expect(body).toContain('if (applied === false) return false;');
    // 事务抛错(toast 之外)也必须让调用方知道「没切」。
    expect(body).toMatch(/\} catch \(err\) \{[\s\S]*?return false;\s*\} finally \{/);
    // 无条件 `return true;` 只剩同引擎重选成功 / 立即切换两条;apply-intent 的成功出口
    // 经完整配置一致性判据返回(2026-08-19 review P2 收口,见下一条锁)。
    expect(body.match(/return true;/g)?.length).toBe(2);
    // 登记成功 ≠ 完整配置落地:回声匹配路径的返回值必须过 effort / Fast 一致性判据 ——
    // 另一控制端在往返期间只改同一意图的档位 / Fast 时,本端请求没有原样落地,按 false
    // 上报,调用方挂在成功上的持久化收尾(onApplied 清 override / 提交・删除收藏编辑 /
    // 写收藏锚点)一律不做。
    expect(body).toContain('return isAgentSwitchEchoConfigConsistent({');
    expect(body).toContain('requestedEffort: newEffort,');
    expect(body).toContain('requestedFastMode: targetFast,');
  });

  it('统一面板的跨引擎回调 await 并透传事务结果,不再返回「确认框过了」', () => {
    const start = source.indexOf('const sessionEngineFilter = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('}, [', start));
    // 取消确认 = false(现状,不变)。**有意变更**(Chris 2026-08-20):确认只认任务真实引擎,
    // 挂着的意图不算已经确认过 —— Claude 任务点了 Pi 收藏再点另一条,仍要弹框。
    expect(body).toContain('if (!(await confirmAgentBrowseSwitch(targetAgent))) return false;');
    expect(body).toContain('runtimeAgent: runtimeAgentKind ?? undefined,');
    // 真实结果原样交出去;绝不再出现 fire-and-forget + 提前 true。
    expect(body).toContain('const applied = await performAgentSwitchRef.current(');
    expect(body).toContain('return applied;');
    expect(body).not.toContain('void performAgentSwitchRef.current(');
    expect(body).not.toContain('return true;');
    // 收藏锚点也挂在**真实结果**上(2026-08-17 review 第三轮 G4):取消 / 失败不记锚点。
    expect(body).toContain('if (applied) {');
    expect(body).toContain('setSessionFavoriteAnchor(');
  });

  it('ack 判定带上「当前权威值就是本次登记那一份」,意图期改选一律 await 并透传结果', () => {
    // 1a:main 先广播 patched、后回 ack,push 必然先到并推走修订号 —— 缺这个判据,每一次
    // 正常登记都被自己的回声判成 stale(乐观呈现 / 草稿同步 / 收藏锚点全不落,而 main 的
    // 意图还在,下一条消息照样切引擎)。
    expect(source).toContain('registeredIntentMatchesCurrent,');
    expect(source).toContain('registeredIntent.target === targetAgentKind');
    expect(source).toContain('registeredIntent.model === newModelId');
    expect(source).toContain('registeredIntent.providerId === providerId');
    // providerId=null(跟随默认路由)时只认 target+model 的通配出口 —— main 可能把 null
    // 解析成具体来源再登记(2026-08-19 review P1 的前半)。
    expect(source).toContain('providerId === null ||');
    // ★ 回声已匹配时 apply-intent **整个跳过 note**(2026-08-19 两轮 P1 的合并收口):
    // store 里已是权威快照,任何本端旧值(null providerId / 旧 newEffort / 旧 targetFast)
    // 盖上去都会与被控端分叉 —— 覆盖「另一控制端只改 effort」「只改 Fast」「两者均改」
    // 与「main 归一化本端登记」全部场景;回声已到过,不会再有第二次权威回流纠正。
    expect(source).toContain('if (!registeredIntentMatchesCurrent) {');
    expect(source).not.toContain('appliedProviderId');
    // ★ 偏好同步同族(2026-08-19 review P2):回声已匹配时 syncSessionDraftModelPrefs 也必须
    // 用权威快照的 effort/fastMode/providerId —— 覆盖 effort-only / Fast-only / 两者均改 /
    // provider 归一化四种场景;权威快照缺某字段时该维不写,不回落本端旧值。
    expect(source).toContain(
      'const authoritative = registeredIntentMatchesCurrent ? registeredIntent : null;',
    );
    expect(source).toContain(
      'const syncedEffort = authoritative ? authoritative.effort : newEffort;',
    );
    expect(source).toContain(
      'const syncedFast = authoritative ? authoritative.fastMode : targetFast;',
    );
    expect(source).toContain(
      'const syncedProviderId = authoritative ? authoritative.providerId : providerId;',
    );
    expect(source).toContain('activeProviderId: syncedProviderId,');
    expect(source).toContain('memoryProviderId: syncedProviderId,');
    // (立即切换 apply-switched 分支仍可用本端值 —— 它以修订号未变为前提,没有已消费的
    // 权威回声,不在本锁范围内。)
    // 1d:意图期改选模型 / 来源必须 await 并把结果交回去,不能 fire-and-forget 返回
    // undefined 让上游读成「已应用」。
    expect(source).not.toContain('void performAgentSwitch(');
    expect(source).toContain('return await performAgentSwitch(intent.target, newModelId, null);');
  });

  /**
   * Chris 2026-08-19「面板原地刷新」+ 2026-08-20「改思维闪关菜单」:
   * disabled 不得参与 popover 开关。`(open && !disabled) || keepOpen` 只保住确认框那条路,
   * 改思维走 performAgentSwitch 时 keepOpen 是 false,选单照关。
   */
  it('ModelSelector 的保命锁不被 disabled 压穿(两个 popover 分支同一表达式)', () => {
    const selectorSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ModelSelector.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const matches = selectorSource.match(/open=\{open \|\| keepOpenForAgentConfirmation\}/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(selectorSource).not.toContain('(open || keepOpenForAgentConfirmation) && !disabled');
    expect(selectorSource).not.toContain('(open && !disabled) || keepOpenForAgentConfirmation');
    // 切引擎成功也不收选单:applied=true 曾经会 setOpen(false),一点胶囊窗口就没了。
    expect(selectorSource).toContain('setOpenWithoutAutoRefresh(true);');
    expect(selectorSource).not.toContain('setOpenWithoutAutoRefresh(applied === false)');
  });

  it('换引擎确认只认任务真实引擎,不认挂着的意图', () => {
    expect(source).toMatch(/runtimeAgentKind != null\s*&&\s*runtimeAgentKind === targetAgent/);
    expect(source).not.toContain(
      'makerChatStore.getAgentSwitchIntent(sessionId)?.target === targetAgent',
    );
  });

  it('会话收藏锚点只认 uid,不拿正在跑的模型/引擎去对副本', () => {
    expect(source).toContain('sessionFavoriteAnchor?.uid ?? null');
    expect(source).not.toContain('sessionFavoriteAnchor.wireModelId === activeModel');
  });

  it('跨引擎选中拿任务真实引擎比,不拿意图目标', () => {
    const actions = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/useUnifiedRowActions.ts'),
      'utf8',
    );
    expect(actions).toContain('const runtimeAgent = sessionEngineFilter?.runtimeAgent;');
    expect(actions).not.toContain(
      'const runtimeAgent = sessionEngineFilter?.runtimeAgent ?? sessionAgent;',
    );
    expect(actions).toContain('if (runtimeAgent === undefined) return true;');
    expect(actions).toContain('shouldCrossEngine(config.agent)');
    expect(actions).toContain('pendingSwitch');
    expect(actions).toContain('favoriteCopyIsLive');
    expect(actions).not.toContain('config.agent !== sessionAgent');
  });

  it('打开选单只滚动选中行,不把焦点从搜索框抢走', () => {
    const panel = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/UnifiedModelPanel.tsx'),
      'utf8',
    );
    const ensure = panel.slice(
      panel.indexOf('const ensureSelectedVisible = useCallback'),
      panel.indexOf('}, [pickerLayout]);'),
    );
    expect(ensure).not.toContain('row.focus');
    expect(ensure).toContain('computeSelectedRowScrollTop');
  });
});

describe('CCAgentSessionView 上下文环压缩入口按 agent 能力分流(#1927)', () => {
  const viewSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/features/cc-agent/CCAgentSessionView.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('onCompact 门控:通道存在 + pi 排除 SSH 远程(remoteHostId) + pi running 禁用,codex 无通道不开放', () => {
    // 门控不再硬编码 agentKind 排除列表:以 compactChannel(能力判定)为准;
    // pi 的 SSH 远程会话(remoteHostId)无 compact-session 路由 → 显式排除
    // (与 SessionContentHeader 压缩菜单仅本地/device-link 一致,Copilot P2)。
    expect(viewSource).toContain('compactChannel !== null');
    expect(viewSource).toContain("!(realAgentKind === 'pi' && !!session?.remoteHostId)");
    // pi 回合运行中会拒绝压缩 → compact-session 通道 running 时禁用(与
    // SessionContentHeader 的 runningSessionIds 一致,codex P1);claude-input 保留旧行为。
    expect(viewSource).toContain(
      "!(compactChannel === 'compact-session' && agentStatus.isRunning)",
    );
    // codex(无 manualCompact)→ compactChannel null → 不开放(纯展示)。
  });

  it('compact-session 分支:粘滞路由 + 确认框后重新分流 + 失败反馈', () => {
    // 分流以当前 render 的 compactChannel 判定(channelNow),确认框返回后重新解析——
    // 同会话在其它窗口/远程被切换 agent 时捕获值会过期(codex P1)。
    expect(viewSource).toContain("if (channelNow === 'compact-session') {");
    // workingDir 只对 claude-input 是硬前提:compact-session(pi 原生压缩)不依赖它。
    expect(viewSource).toContain(
      "if (sourceCompactChannel === 'claude-input' && !sourceSession.workingDir) return;",
    );
    // device-link 远程 pi:粘滞归属路由到被控端,relay 重连窗口内不退回本机(greptile P1)。
    expect(viewSource).toContain('const sourceSessionId = sourceSession.id;');
    expect(viewSource).toContain('const maker = makerApiForSticky(sourceSessionId);');
    expect(viewSource).toContain('await maker.compactSession(sourceSessionId)');
    // 在途期间切换会话 / 登出 / 切回(换代):旧响应不得在当前视图弹 toast(并发收口)。
    expect(viewSource).toContain('const committedSessionId = sessionId ?? null;');
    expect(viewSource).toContain('compactRequestGuard.setCurrentSession(committedSessionId)');
    // 代校验:sessionId 当前 + 请求代一致;finally 里 release(不再按 sessionId finish)。
    expect(viewSource).toContain('const begun = compactRequestGuard.tryBegin(sourceSessionId);');
    expect(viewSource).toContain('if (!begun) return;');
    expect(viewSource).toContain('compactRequestGuard.isCurrent(sourceSessionId, begun.epoch)');
    expect(viewSource).toContain('begun.release();');
    // 真实 reject 必须 catch 并显示 compactFailed。
    expect(viewSource).toContain("toast.warning(t('ccAgent.sidebar.sessionMenu.compactFailed'))");
  });

  it('claude-code 分支保持 inputCoordinator compactSession(model,...),不误入 compact-session', () => {
    // compact-session 分支以 return 结束;return 之前只有 makerApiForSticky 通道,
    // 不调用 inputCoordinator 的 compactSession(model, effort, ...)(即 maker:input:compact)。
    const csStart = viewSource.indexOf("if (channelNow === 'compact-session')");
    expect(csStart).toBeGreaterThan(-1); // 定位必须命中,否则断言形同虚设(copilot review)
    const csEnd = viewSource.indexOf('return;', csStart);
    const csBranch = viewSource.slice(csStart, csEnd);
    expect(csBranch).not.toContain('await compactSession(');
    // 确认框返回后若 channel 已消失(能力被撤/agent 切换)则放弃,不静默误调。
    // 关键:重分流必须读 compactChannelRef.current(useCallback 闭包固定捕获旧值,
    // 旧 async 函数 await 期间重新 render 也不会更新闭包——greptile review)。
    expect(viewSource).toContain('const compactChannelRef = useRef(compactChannel);');
    expect(viewSource).toContain('compactChannelRef.current = compactChannel;');
    expect(viewSource).toContain('const channelNow = compactChannelRef.current;');
    expect(viewSource).toContain('if (channelNow === null) return;');
    // claude 通道执行前才校验 workingDir(输入协调器硬前提),且参数必须来自**最新**
    // session 快照——同会话切换 agent 后 model/effort/permission/workingDir 已变化,
    // 旧快照会按错误配置执行(greptile P1 / codex P2)。
    expect(viewSource).toContain('const sessionRef = useRef(session);');
    expect(viewSource).toContain('sessionRef.current = session;');
    expect(viewSource).toContain('const sessionNow = sessionRef.current;');
    expect(viewSource).toContain("if (channelNow !== 'claude-input') return;");
    expect(viewSource).toContain('if (!sessionNow?.workingDir) return;');
    expect(viewSource).toContain('sessionNow.model,');
    // 确认框期间 turn 可能已从其它窗口/远程启动:render 时 isRunning 守卫失效,重读
    // 最新 running ref,活跃 turn 的 pi 拒绝压缩 → 放弃(codex P2);claude-input 保留旧行为。
    expect(viewSource).toContain('const isRunningRef = useRef(agentStatus.isRunning);');
    expect(viewSource).toContain('isRunningRef.current = agentStatus.isRunning;');
    expect(viewSource).toContain(
      "if (channelNow === 'compact-session' && isRunningRef.current) return;",
    );
  });
});

describe('上下文环压缩请求按 sessionId 隔离(#1927 并发/生命周期回归)', () => {
  it('A 在途时 B 可独立开始，A 的迟到 release 不会清掉 B 的锁', () => {
    const guard = createSessionScopedRequestGuard();
    guard.setCurrentSession('A');
    const beginA = guard.tryBegin('A');
    expect(beginA).not.toBeNull();
    expect(guard.tryBegin('A')).toBeNull(); // 同代同会话防重

    guard.setCurrentSession('B');
    expect(guard.isCurrent('A')).toBe(false);
    const beginB = guard.tryBegin('B');
    expect(beginB).not.toBeNull();

    beginA!.release();
    expect(guard.tryBegin('B')).toBeNull(); // B 的锁还在
    beginB!.release();
    expect(guard.tryBegin('B')).not.toBeNull();
  });

  it('A 在途切 B 再切回 A(换代):旧请求失效,且新点击不被旧锁挡住', () => {
    // greptile P1:守卫只按 sessionId 判断时,切回 A 后旧 A 请求会重新通过 isCurrent
    // (迟到 toast),旧锁还会让新点击被静默丢弃。代(epoch)语义修复两者。
    const guard = createSessionScopedRequestGuard();
    guard.setCurrentSession('A');
    const oldA = guard.tryBegin('A');
    expect(oldA).not.toBeNull();
    const oldEpoch = oldA!.epoch;

    guard.setCurrentSession('B');
    guard.setCurrentSession('A'); // 切回 A → 换代

    // 旧 A 请求:sessionId 当前但代不匹配 → 失效(不弹迟到 toast)。
    expect(guard.isCurrent('A', oldEpoch)).toBe(false);
    expect(guard.isCurrent('A')).toBe(true); // 无代校验时仍视为当前展示会话
    // 新点击:同会话但新代 → 不被旧锁挡住,可独立开始。
    const newA = guard.tryBegin('A');
    expect(newA).not.toBeNull();
    expect(newA!.epoch).not.toBe(oldEpoch);
    newA!.release();
    oldA!.release();
  });

  it('切换会话或登出会让确认框/迟到响应的旧 scope 失效', () => {
    const guard = createSessionScopedRequestGuard();
    guard.setCurrentSession('A');
    const beginA = guard.tryBegin('A');
    expect(beginA).not.toBeNull();
    const epochA = beginA!.epoch;
    guard.setCurrentSession('B');
    expect(guard.isCurrent('A', epochA)).toBe(false);
    expect(guard.isCurrent('B')).toBe(true);
    guard.setCurrentSession(null);
    expect(guard.isCurrent('B')).toBe(false);
  });
});

describe('resolveManualCompactChannel(#1927 压缩通道判定,行为测试)', () => {
  // zqchris 要求按行为覆盖而非源码字符串匹配:共享判定收敛成纯函数,直接测语义。
  it('真实 Claude Code → claude-input(maker:input:compact),与 capability 无关', () => {
    expect(resolveManualCompactChannel('claude-code', null)).toBe('claude-input');
    expect(
      resolveManualCompactChannel('claude-code', {
        manualCompact: { supported: false, reason: 'sdk-missing' },
      }),
    ).toBe('claude-input');
  });

  it('声明 manualCompact.supported(当前仅 pi)→ compact-session(capability-aware 通道)', () => {
    expect(resolveManualCompactChannel('pi', { manualCompact: { supported: true } })).toBe(
      'compact-session',
    );
  });

  it('无能力(Codex / 能力快照缺失)→ 无入口,不按 agentKind 扩排除列表', () => {
    expect(resolveManualCompactChannel('codex', null)).toBeNull();
    expect(
      resolveManualCompactChannel('codex', {
        manualCompact: { supported: false, reason: 'sdk-missing' },
      }),
    ).toBeNull();
    // 能力快照未命中(缓存未就绪)保守关闭入口,而不是猜能力。
    expect(resolveManualCompactChannel('pi', null)).toBeNull();
    expect(resolveManualCompactChannel(undefined, null)).toBeNull();
  });
});
