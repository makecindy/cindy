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
import ts from 'typescript';
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

  it('远程 Agent 换电脑:位置随意图镜像(null = 任务所在电脑),脏值按位置不变处理', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'claude-code',
      model: 'anthropic/claude-opus-5-5[1m]',
      providerId: 'xd',
      agentDeviceId: null,
    });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toMatchObject({ agentDeviceId: null });

    // 位置不同 = 不同的意图,不能当成同一份回声吞掉。
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'claude-code',
      model: 'anthropic/claude-opus-5-5[1m]',
      providerId: 'xd',
      agentDeviceId: 'studio-mac',
    });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent?.agentDeviceId).toBe('studio-mac');

    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'claude-code',
      model: 'm',
      providerId: 'xd',
      agentDeviceId: 42,
    });
    const intent = makerChatStore.getSnapshot(s).agentSwitchIntent;
    expect(intent?.model).toBe('m');
    expect(intent && 'agentDeviceId' in intent).toBe(false);
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
describe("ChatInput 的入口门控与调用路由", () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('Orca 会话复用切换入口，角色未加载仍保留未知态', () => {
    const expression = source.match(/const sessionAgentSwitchSupported =\s*([\s\S]*?);/)?.[1];
    if (!expression) throw new Error('Agent switch capability expression was not found');
    const supported = new Function('sessionOrcaRole', 'runtimeAgentKind', 'deviceLinkDeviceId',
      'ccSupportsSessionAgentSwitch', 'codexSupportsSessionAgentSwitch', `return ${expression};`);
    for (const role of [null, 'lead', 'worker']) {
      expect(supported(role, 'codex', null, false, false)).toBe(true);
      expect(supported(role, undefined, null, true, true)).toBe(false);
      expect(supported(role, 'codex', 'host', false, false)).toBe(false);
      expect(supported(role, 'codex', 'host', false, true)).toBe(true);
    }
    expect(supported(undefined, 'codex', null, true, true)).toBe(false);
    const remoteOptions = source.slice(source.indexOf('const sessionRemoteAgentOptions ='),
      source.indexOf('// composer pill 尾部引擎小标'));
    const relocationGuard = remoteOptions.match(/if \(([\s\S]*?)\) return undefined;/)?.[1];
    if (!relocationGuard) throw new Error('Remote-agent relocation guard was not found');
    const hidden = new Function('sessionOrcaRole', 'sessionOrcaRemoteWorker', 'deviceLinkDeviceId',
      `const sessionId = 's1', agentLocationAware = true, remoteHostId = null, sessionEngineFilter = {};
       return !!(${relocationGuard});`);
    // 本机的 Lead / Worker 与普通任务一样可换 Agent 所在电脑。
    for (const role of [null, 'lead', 'worker']) {
      expect(hidden(role, false, null)).toBe(false);
    }
    // 被控电脑上的协同任务先不开放(旧版被控端会拒绝);普通被控任务不受影响。
    expect(hidden('lead', false, 'host')).toBe(true);
    expect(hidden('worker', false, 'host')).toBe(true);
    expect(hidden(null, false, 'host')).toBe(false);
    for (const role of [null, 'lead', 'worker', undefined]) {
      expect(hidden(role, true, null)).toBe(true);
    }
    expect(hidden(undefined, false, null)).toBe(true);
  });

  it.each(['lead', 'worker'])('Desktop Orca %s routes same-Agent model and provider picks through the switch intent', async sessionOrcaRole => {
    const parsed = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Map<string, string>();
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
        && ['performModelChange', 'performProviderChange'].includes(node.name.getText(parsed))) {
        callbacks.set(node.name.getText(parsed), node.initializer.arguments[0].getText(parsed));
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    const switchAgent = vi.fn(async () => true);
    const bindings = { sessionOrcaRole, settingsLocked: false, sessionId: 's1',
      sessionAgentSwitchSupported: true, remoteHostId: null, runtimeAgentKind: 'codex',
      makerChatStore: { getAgentSwitchIntent: () => null }, performAgentSwitch: switchAgent,
      effectiveSourceId: 'provider-old', activeModel: 'model-old' };
    function callback(name: string) {
      if (!callbacks.has(name)) throw new Error(`Composer callback ${name} was not found`);
      const compiled = ts.transpileModule(`return ${callbacks.get(name)};`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
    }
    expect(await callback('performModelChange')('model-new')).toBe(true);
    expect(switchAgent).toHaveBeenLastCalledWith('codex', 'model-new', 'provider-old');
    expect(await callback('performProviderChange')('provider-new', 'model-new', 'high', undefined, true)).toBe(true);
    expect(switchAgent).toHaveBeenLastCalledWith('codex', 'model-new', 'provider-new', { effort: 'high', fastMode: true });
    switchAgent.mockResolvedValue(false);
    expect(await callback('performModelChange')('rejected-model')).toBe(false);
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
