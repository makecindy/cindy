/**
 * dispatcher 单测: 注入假 runner / bindings / store, 覆盖协议语义的全部分支 ——
 * 幂等回放、别名白名单、binding 复用(同 key 同 session)、接管(sessionId 路径
 * 及其两种拒绝)、排队 FIFO、turn.end 回推与离线缓存补发。
 */

import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  HOOK_FEATURE_TURN_REOPEN,
  type HookMessage,
  type TaskDispatchPayload,
} from '@cindy/slack-hook-protocol';

import {
  buildHookSessionTitle,
  createHookDispatcher,
  normalizeTaskSource,
  type HookContinuationWatchRequest,
  type HookDispatcherDeps,
  type HookRunOutcome,
  type HookRunRequest,
  type HookSessionRunner,
  type PrepareWorktreeResult,
} from '../dispatcher';
import type { HookBindingStore } from '../bindings';
import { isPathWithin } from '../paths';
import type { HookConnectionConfig } from '../store';

const noopLog = { info: () => {}, warn: () => {} };

const WS_DIR = path.resolve('/repos/xdmaker');

const CONFIG: HookConnectionConfig = {
  id: 'conn-1',
  name: 'my-hooks',
  url: 'wss://x',
  enabled: true,
  workspaces: { xdmaker: WS_DIR },
  createdAt: 0,
};

/** 内存 binding(与文件实现同语义: 只存 externalKey -> sessionId)。 */
function memoryBindings(): HookBindingStore {
  const map = new Map<string, string>();
  const k = (c: string, e: string): string => `${c}|${e}`;
  return {
    get: (c, e) => map.get(k(c, e)) ?? null,
    set: (c, e, s) => void map.set(k(c, e), s),
    remove: (c, e) => void map.delete(k(c, e)),
  };
}

/**
 * 可控假 runner: run 挂起直到测试显式 resolve —— 用于验证排队;
 * sessions 表模拟 inspect。
 */
function fakeRunner(opts?: { sessions?: Record<string, { workingDir: string; usable: boolean }> }) {
  const sessions = opts?.sessions ?? {};
  const calls: HookRunRequest[] = [];
  const resolvers: Array<(o: HookRunOutcome) => void> = [];
  const busy = new Set<string>();
  const runner: HookSessionRunner = {
    isBusy: (id) => busy.has(id),
    inspect: async (id) => (sessions[id] ? { ...sessions[id] } : null),
    run: (req) => {
      calls.push(req);
      return new Promise<HookRunOutcome>((resolve) => resolvers.push(resolve));
    },
  };
  return {
    runner,
    calls,
    busy,
    /** 结束最早一个挂起的 run。 */
    finish(outcome?: Partial<HookRunOutcome>) {
      const r = resolvers.shift();
      if (!r) throw new Error('no pending run');
      r({ status: 'ok', finalText: 'done', errorMessage: null, durationMs: 5, ...outcome });
    },
    pendingCount: () => resolvers.length,
  };
}

/** 收集出帧的 send。 */
function collector(online = true) {
  const sent: HookMessage[] = [];
  let up = online;
  return {
    sent,
    setOnline: (v: boolean) => (up = v),
    send: (m: HookMessage): boolean => {
      if (!up) return false;
      sent.push(m);
      return true;
    },
    /** 最后一帧某类型的 payload。 */
    last<T extends HookMessage['type']>(type: T) {
      const hits = sent.filter((m) => m.type === type);
      return hits.length ? (hits[hits.length - 1] as Extract<HookMessage, { type: T }>) : null;
    },
    ofType<T extends HookMessage['type']>(type: T) {
      return sent.filter((m): m is Extract<HookMessage, { type: T }> => m.type === type);
    },
  };
}

function dispatch(overrides: Partial<TaskDispatchPayload> = {}): TaskDispatchPayload {
  return {
    requestId: 'req-1',
    externalKey: 'team-slack:C1:1.1',
    workspace: 'xdmaker',
    sessionId: null,
    prompt: '干活',
    ...overrides,
  };
}

async function tick(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeDispatcher(overrides?: {
  runner?: HookSessionRunner;
  bindings?: HookBindingStore;
  config?: HookConnectionConfig | null;
  prepareWorktree?: HookDispatcherDeps['prepareWorktree'];
  dialogue?: HookDispatcherDeps['dialogue'];
  abortSession?: HookDispatcherDeps['abortSession'];
  subscribeUiContinuation?: HookDispatcherDeps['subscribeUiContinuation'];
  subscribeUiSessionIntervention?: HookDispatcherDeps['subscribeUiSessionIntervention'];
  subscribeUiTurnDispatching?: HookDispatcherDeps['subscribeUiTurnDispatching'];
  subscribeUiTurnUndispatched?: HookDispatcherDeps['subscribeUiTurnUndispatched'];
  accountInitiallyActive?: boolean;
}) {
  const bindings = overrides?.bindings ?? memoryBindings();
  const fr = fakeRunner();
  const runner = overrides?.runner ?? fr.runner;
  const d = createHookDispatcher({
    getConnection: () => (overrides?.config === undefined ? CONFIG : overrides.config),
    bindings,
    runner,
    prepareWorktree: overrides?.prepareWorktree,
    dialogue: overrides?.dialogue,
    abortSession: overrides?.abortSession,
    subscribeUiContinuation: overrides?.subscribeUiContinuation,
    subscribeUiSessionIntervention: overrides?.subscribeUiSessionIntervention,
    subscribeUiTurnDispatching: overrides?.subscribeUiTurnDispatching,
    subscribeUiTurnUndispatched: overrides?.subscribeUiTurnUndispatched,
    accountInitiallyActive: overrides?.accountInitiallyActive,
    log: noopLog,
  });
  return { d, bindings, fr };
}

describe('isPathWithin', () => {
  it('相等 / 子目录 / 外部路径', () => {
    expect(isPathWithin(WS_DIR, WS_DIR)).toBe(true);
    expect(isPathWithin(WS_DIR, path.join(WS_DIR, 'sub'))).toBe(true);
    expect(isPathWithin(WS_DIR, path.resolve('/repos/other'))).toBe(false);
    // 前缀相似但非子目录(/repos/xdmaker-evil)不放行
    expect(isPathWithin(WS_DIR, `${WS_DIR}-evil`)).toBe(false);
  });
});

describe('buildHookSessionTitle', () => {
  it('短消息原样进标题, 换行/连续空白压平成单空格', () => {
    expect(buildHookSessionTitle('slack', '修一下登录页', 'C1:1.1')).toBe('[Slack] 修一下登录页');
    expect(buildHookSessionTitle('slack', ' 修一下\n登录页  的样式 ', 'C1:1.1')).toBe(
      '[Slack] 修一下 登录页 的样式',
    );
  });

  it('超长消息截断到 24 字加省略号', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    expect(buildHookSessionTitle('slack', long, 'C1:1.1')).toBe(`[Slack] ${long.slice(0, 24)}…`);
  });

  it('空消息(纯图片派发)回退渠道内标识', () => {
    expect(buildHookSessionTitle('slack', '   \n ', 'C1:1.1')).toBe('[Slack] C1:1.1');
  });

  it('DM 会话(bareKey 带 dm: 前缀)标题前缀标 ·DM', () => {
    expect(buildHookSessionTitle('slack', '帮我看看这个报错', 'dm:U1:g0')).toBe(
      '[Slack·DM] 帮我看看这个报错',
    );
    // 空消息回退 bareKey 时 DM 标同样生效
    expect(buildHookSessionTitle('slack', '', 'dm:U1:g0')).toBe('[Slack·DM] dm:U1:g0');
  });

  it('(multi-team)teamName 非空时并入方括号首段; 空/空白不加', () => {
    expect(buildHookSessionTitle('slack', '修登录页', 'C1:1.1', 'acme')).toBe(
      '[acme·Slack] 修登录页',
    );
    expect(buildHookSessionTitle('slack', '修登录页', 'dm:U1:g0', 'acme')).toBe(
      '[acme·Slack·DM] 修登录页',
    );
    expect(buildHookSessionTitle('slack', '修登录页', 'C1:1.1', null)).toBe('[Slack] 修登录页');
    expect(buildHookSessionTitle('slack', '修登录页', 'C1:1.1', '  ')).toBe('[Slack] 修登录页');
  });

  it('Telegram group/topic 名称进入来源标题', () => {
    expect(
      buildHookSessionTitle('telegram', '继续发布', 'topic:bot:-1:77:user:g1', 'Release topic'),
    ).toBe('[Release topic·Telegram] 继续发布');
  });
});

describe('normalizeTaskSource', () => {
  it('bounds server-controlled display metadata before session persistence', async () => {
    const source = normalizeTaskSource({
      im: 'telegram',
      channelName: 'c'.repeat(200),
      teamId: 'i'.repeat(200),
      teamName: 'n'.repeat(200),
      userText: 'u'.repeat(20_100),
      threadContext: Array.from({ length: 25 }, (_, index) => ({
        author: `author-${index}-${'a'.repeat(140)}`,
        text: 't'.repeat(4_100),
        isBot: index === 0,
      })),
    });

    expect(source.channelName).toHaveLength(160);
    expect(source.teamId).toHaveLength(128);
    expect(source.teamName).toHaveLength(160);
    expect(source.userText).toHaveLength(20_000);
    expect(source.threadContext).toHaveLength(20);
    expect(source.threadContext?.[0]).toEqual({
      author: expect.any(String),
      text: expect.any(String),
      isBot: true,
    });
    expect(source.threadContext?.[0]?.author).toHaveLength(128);
    expect(source.threadContext?.[0]?.text).toHaveLength(4_000);
    expect(source.threadContext?.[1]).not.toHaveProperty('isBot');
  });

  it('passes only normalized source metadata to the runner', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch(
      'conn-1',
      dispatch({
        source: {
          im: 'telegram',
          channelName: 'c'.repeat(200),
          userText: 'u'.repeat(20_100),
        },
      }),
      c.send,
    );
    await tick();

    expect(fr.calls[0]?.source?.channelName).toHaveLength(160);
    expect(fr.calls[0]?.source?.userText).toHaveLength(20_000);
    fr.finish();
  });

  it('laneKind 派生: telegram group/topic externalKey → group, DM 与 Slack → dm', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    const keys = [
      'telegram:group:bot:-900:42:9:g0',
      'telegram:topic:bot:-900:77:9:g0',
      'telegram:dm:bot:user:g0',
      'team-slack:C1:1.1',
    ];
    for (const [i, externalKey] of keys.entries()) {
      d.handleDispatch('conn-1', dispatch({ requestId: `req-lane-${i}`, externalKey }), c.send);
      await tick();
      fr.finish();
      await tick();
    }
    expect(fr.calls.map((call) => call.laneKind)).toEqual(['group', 'group', 'dm', 'dm']);
  });
});

describe('dispatcher 核心语义', () => {
  it('账号 ingress 未打开时丢弃派发，activate 后才开始处理', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner, accountInitiallyActive: false });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(c.sent).toEqual([]);
    expect(fr.calls).toEqual([]);

    d.activateAccount();
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(c.last('task.ack')?.payload.result).toBe('accepted');
    expect(fr.calls).toHaveLength(1);
    fr.finish();
  });

  it('切账号会中止在途任务、清排队并丢弃旧代 turn.end，重新激活后恢复', async () => {
    const fr = fakeRunner();
    const aborted: string[] = [];
    const { d } = makeDispatcher({
      runner: fr.runner,
      abortSession: async (sessionId) => void aborted.push(sessionId),
    });
    const c = collector();

    d.handleDispatch('conn-1', dispatch({ requestId: 'old-running' }), c.send);
    await tick();
    const oldSessionId = c.last('task.ack')?.payload.sessionId;
    expect(oldSessionId).toBeTruthy();
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'old-queued', externalKey: 'team-slack:C1:1.1' }),
      c.send,
    );
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({
      requestId: 'old-queued',
      result: 'queued',
    });

    const draining = d.deactivateAccount();
    let duplicateDrainSettled = false;
    const duplicateDrain = d.deactivateAccount().then(() => {
      duplicateDrainSettled = true;
    });
    await tick();
    expect(aborted).toEqual([oldSessionId]);
    expect(duplicateDrainSettled).toBe(false);
    fr.finish({ finalText: 'must not cross account boundary' });
    await Promise.all([draining, duplicateDrain]);
    expect(c.ofType('turn.end')).toHaveLength(0);
    expect(fr.calls).toHaveLength(1);

    d.handleDispatch('conn-1', dispatch({ requestId: 'still-closed' }), c.send);
    await tick();
    expect(fr.calls).toHaveLength(1);

    d.activateAccount();
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'new-account', externalKey: 'team-slack:C2:2.2' }),
      c.send,
    );
    await tick();
    expect(fr.calls).toHaveLength(2);
    fr.finish({ finalText: 'new account result' });
    await tick();
    expect(c.last('turn.end')?.payload).toMatchObject({
      requestId: 'new-account',
      finalText: 'new account result',
    });
  });

  it('收口期间的重新激活会被后到的关闭请求作废', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch({ requestId: 'old-account' }), c.send);
    await tick();
    expect(fr.calls).toHaveLength(1);

    const firstDrain = d.deactivateAccount();
    d.activateAccount();
    const finalDrain = d.deactivateAccount();
    fr.finish();
    await Promise.all([firstDrain, finalDrain]);

    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'must-stay-closed', externalKey: 'team-slack:C2:2.2' }),
      c.send,
    );
    await tick();
    expect(fr.calls).toHaveLength(1);
    expect(c.ofType('task.ack').some((ack) => ack.payload.requestId === 'must-stay-closed')).toBe(
      false,
    );
  });

  it('新 key -> 新建 session, accepted, turn.end 带原样 externalKey', async () => {
    const fr = fakeRunner();
    const { d, bindings } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();

    const ack = c.last('task.ack');
    expect(ack?.payload).toMatchObject({ requestId: 'req-1', result: 'accepted' });
    const sessionId = ack!.payload.sessionId!;
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBe(sessionId);
    expect(fr.calls[0]).toMatchObject({
      isNew: true,
      workingDir: WS_DIR,
      prompt: '干活',
      // 标题带 provider 名(externalKey 前缀), 不用 desktop 侧连接名;
      // 后半段用首条消息摘要(可读), 不再用"频道 ID:时间戳"
      title: '[Team-slack] 干活',
    });

    fr.finish({ finalText: '搞定了' });
    await tick();
    const end = c.last('turn.end');
    expect(end?.payload).toMatchObject({
      requestId: 'req-1',
      externalKey: 'team-slack:C1:1.1',
      sessionId,
      status: 'ok',
      finalText: '搞定了',
    });
  });

  it('同 key 第二次 dispatch 复用同一 session(铁律)', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    // 让 inspect 能看到这个 session(模拟已落库)
    sessions[first] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    const second = c.last('task.ack')!.payload;
    expect(second.result).toBe('accepted');
    expect(second.sessionId).toBe(first);
    expect(fr.calls[1]).toMatchObject({ isNew: false, sessionId: first });
    fr.finish();
  });

  it('会话被移出工作目录映射 -> 断开绑定、换新对话并说明, 不跟随到映射外', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    // 用户在桌面端把这条会话「移动到项目」, 目标目录不在工作目录映射里
    const MOVED_DIR = path.resolve('/repos/another-project');
    sessions[first] = { workingDir: MOVED_DIR, usable: true };

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    const second = c.last('task.ack')!.payload.sessionId!;
    // 映射是唯一边界: 移出去就不再驱动它, 这条消息换新对话在映射内跑
    expect(second).not.toBe(first);
    expect(fr.calls[1]).toMatchObject({ isNew: true, workingDir: WS_DIR });
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBe(second);

    fr.finish({ finalText: '新对话的回答' });
    await tick();
    const finalText = c.last('turn.end')!.payload.finalText;
    expect(finalText).toContain('原任务已不在可用的工作目录里');
    expect(finalText).toContain('把它所在的目录加进来');
    expect(finalText).toContain('新对话的回答');
  });

  it('旧任务还在跑时被移出映射: 新消息不排进旧会话(快路径也过边界)', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    // 第一轮仍在执行(没有 fr.finish): session 落库并被用户移出映射
    sessions[first] = { workingDir: path.resolve('/repos/another-project'), usable: true };

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    // 免检快路径只保「尚未落库」的窗口 —— 已落库的会话在跑也要过映射校验,
    // 否则这条消息会排进旧会话, 由 session meta 的 workDir 带到映射外执行
    const second = c.last('task.ack')!.payload.sessionId!;
    expect(second).not.toBe(first);
    expect(c.last('task.ack')!.payload.result).toBe('accepted');
    expect(fr.calls[1]).toMatchObject({ isNew: true, workingDir: WS_DIR });
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBe(second);

    fr.finish();
    await tick();
    fr.finish();
    await tick();
  });

  it('inspect 瞬时失败(返回 null)不构成免检: 已落库的会话仍按边界处理', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    // 第二轮开着不收口, 让 first 留在 running 里
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.sessionId).toBe(first);

    // 模拟 meta / DB 读取瞬时失败: inspect 也返回 null, 与"不存在"不可区分。
    // 免检窗口只认 awaitingPersist(本 dispatcher 新建且未落库), first 早已出局,
    // 所以这里必须 fail closed 而不是把消息排进 first。
    delete sessions[first];
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-3' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.sessionId).not.toBe(first);

    fr.finish();
    await tick();
    fr.finish();
    await tick();
  });

  it('免检窗口内别名被改指: 未落库的会话也要重过映射校验, 不再免检', async () => {
    const bindings = memoryBindings();
    const fr = fakeRunner(); // sessions 恒空 -> inspect 一直返回 null(未落库)
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const { d } = makeDispatcher({ runner: fr.runner, bindings, config });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    expect(fr.calls[0]).toMatchObject({ isNew: true, workingDir: WS_DIR });

    // 第一轮还在 agent.startSession 里(没落库、没收口), 此时用户把别名改指走
    config.workspaces = { xdmaker: path.resolve('/repos/elsewhere') };

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    // 只认 sessionId 的话这条会排进 first —— 而 first 建在已撤权的目录里
    expect(c.last('task.ack')!.payload.sessionId).not.toBe(first);

    fr.finish();
    await tick();
    fr.finish();
    await tick();
  });

  it('排队期间映射被撤权: drain 时不执行, 回一条说明而不是在已撤权目录里跑', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const { d } = makeDispatcher({ runner: fr.runner, bindings, config });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: WS_DIR, usable: true };

    // 第一轮没收口时第二条进队列(此刻目录还在映射内, 校验通过)
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload).toMatchObject({ result: 'queued' });

    // 排队期间用户把这个目录从映射里删掉 —— 会话目录和 expectedWorkingDir 都
    // 没变, 只有"映射还认不认它"变了, 所以必须在开跑前重新查映射
    config.workspaces = {};
    fr.finish({ finalText: '第一条跑完了' });
    await tick();

    const ends = c.ofType('turn.end').map((m) => m.payload);
    const queued = ends.find((e) => e.requestId === 'req-2')!;
    expect(queued.status).toBe('error');
    expect(queued.errorMessage).toContain('已不在工作目录映射里');
    // 关键: 排队那条根本没进 runner
    expect(fr.calls).toHaveLength(1);
  });

  it('新建会话在定位与执行之间被撤权: 同样不执行(新建路径也走执行侧收口)', async () => {
    const fr = fakeRunner();
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    let release!: (v: PrepareWorktreeResult) => void;
    const { d } = makeDispatcher({
      runner: fr.runner,
      config,
      prepareWorktree: () =>
        new Promise<PrepareWorktreeResult>((resolve) => {
          release = resolve;
        }),
    });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    // 定位还卡在 worktree 预建上, 此时用户把这个目录从映射里删掉
    config.workspaces = {};
    release({ ok: false, message: 'no worktree' });
    await tick();

    // 新建路径没有 expectedWorkingDir, 但 workingDir 就是要跑的目录, 照样拦下
    expect(fr.calls).toHaveLength(0);
    const end = c.last('turn.end')!.payload;
    expect(end.status).toBe('error');
    expect(end.errorMessage).toContain('已不在工作目录映射里');
  });

  it('排队期间连接被停用: 目录还在映射里也不执行', async () => {
    const fr = fakeRunner({ sessions: {} });
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const { d } = makeDispatcher({ runner: fr.runner, config });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.result).toBe('queued');

    // 用户关掉了这条连接 —— 通道已切断, 排着的远端任务不能因为"目录还在映射里"就跑
    config.enabled = false;
    fr.finish();
    await tick();

    expect(fr.calls).toHaveLength(1);
    const queued = c
      .ofType('turn.end')
      .map((m) => m.payload)
      .find((e) => e.requestId === 'req-2')!;
    expect(queued.status).toBe('error');
  });

  it('执行前被拦下时回收预建的 worktree(不留孤儿)', async () => {
    const fr = fakeRunner();
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const cleanup = vi.fn(async () => undefined);
    let release!: (v: PrepareWorktreeResult) => void;
    const { d } = makeDispatcher({
      runner: fr.runner,
      config,
      prepareWorktree: () =>
        new Promise<PrepareWorktreeResult>((resolve) => {
          release = resolve;
        }),
    });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    config.workspaces = {};
    release({ ok: true, sessionId: 'wt-session', path: path.join(WS_DIR, 'wt'), cleanup });
    await tick();

    expect(fr.calls).toHaveLength(0);
    // worktree 已经建出来了却没有会话认领 —— 必须就地回收
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('isDirAuthorized 按当前映射回答, 供 runner 校验实际执行目录', async () => {
    const fr = fakeRunner();
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const { d } = makeDispatcher({ runner: fr.runner, config });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const ask = fr.calls[0].isDirAuthorized!;
    expect(ask(WS_DIR)).toBe(true);
    expect(ask(path.join(WS_DIR, 'sub'))).toBe(true);
    expect(ask(path.resolve('/repos/elsewhere'))).toBe(false);

    // 映射被改后同一个回调立刻反映新状态(runner 是在 await 之后才问的)
    config.workspaces = { xdmaker: path.resolve('/repos/elsewhere') };
    expect(ask(WS_DIR)).toBe(false);
    expect(ask(path.resolve('/repos/elsewhere'))).toBe(true);
    fr.finish();
  });

  it('inspect 期间目录被加回映射: 按当前映射判定, 不误杀这条绑定', async () => {
    const bindings = memoryBindings();
    const OUTSIDE = path.resolve('/repos/another-project');
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {
      'bound-session': { workingDir: OUTSIDE, usable: true },
    };
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    let releaseInspect!: () => void;
    const runner: HookSessionRunner = {
      isBusy: () => false,
      inspect: async (id) => {
        await new Promise<void>((resolve) => {
          releaseInspect = resolve;
        });
        return sessions[id] ? { ...sessions[id] } : null;
      },
      run: async () => ({ status: 'ok', finalText: 'done', errorMessage: null, durationMs: 1 }),
    };
    const { d } = makeDispatcher({ runner, bindings, config });
    const c = collector();
    bindings.set('conn-1', 'team-slack:C1:1.1', 'bound-session');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    // inspect 还挂着时用户把这个目录加进了映射 —— 入口快照里没有它, 当前映射有
    config.workspaces = { xdmaker: WS_DIR, other: OUTSIDE };
    releaseInspect();
    await tick();

    expect(c.last('task.ack')!.payload.sessionId).toBe('bound-session');
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBe('bound-session');
  });

  it('在工作目录映射内换目录 -> 无感跟随复用(边界内的移动不受影响)', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    // 移到映射根下的子目录: 仍在边界内, 判定无状态所以直接复用
    const INSIDE = path.join(WS_DIR, 'packages', 'sub-project');
    sessions[first] = { workingDir: INSIDE, usable: true };

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload).toMatchObject({ result: 'accepted', sessionId: first });
    expect(fr.calls[1]).toMatchObject({ isNew: false, sessionId: first, workingDir: INSIDE });

    fr.finish({ finalText: '在子目录里跑完了' });
    await tick();
    // 边界内的移动不打扰用户
    expect(c.last('turn.end')!.payload.finalText).toBe('在子目录里跑完了');
  });

  it('移出映射后再移回映射内 -> 恢复正常复用(绑定不留任何过期授权)', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    const OUTSIDE = path.resolve('/repos/another-project');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    // 第一条消息后它就被移出映射: 绑定改指新对话
    sessions[first] = { workingDir: OUTSIDE, usable: true };
    fr.finish();
    await tick();

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    const second = c.last('task.ack')!.payload.sessionId!;
    expect(second).not.toBe(first);
    sessions[second] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    // 新对话在映射内, 此后照常复用
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-3' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload).toMatchObject({ result: 'accepted', sessionId: second });
    fr.finish();
  });

  it('工作目录映射被改(会话目录没变) -> 仍丢绑定重建, 并说明原因', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const { d } = makeDispatcher({ runner: fr.runner, bindings, config });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    // 用户把别名改指到别的目录 = 撤销旧目录的 IM 访问, 旧会话不得继续被驱动
    config.workspaces = { xdmaker: path.resolve('/repos/elsewhere') };

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    const second = c.last('task.ack')!.payload.sessionId!;
    expect(second).not.toBe(first);
    expect(fr.calls[1]).toMatchObject({
      isNew: true,
      workingDir: path.resolve('/repos/elsewhere'),
    });

    fr.finish({ finalText: '新会话的回答' });
    await tick();
    const finalText = c.last('turn.end')!.payload.finalText;
    expect(finalText).toContain('原任务已不在可用的工作目录里');
    expect(finalText).toContain('新会话的回答');
  });

  it('存量绑定(带早期版本残留字段)照常判定: 在映射内即复用, 越界即重建', async () => {
    const reuse = memoryBindings();
    const fr1 = fakeRunner({ sessions: { 'old-session': { workingDir: WS_DIR, usable: true } } });
    const { d: d1 } = makeDispatcher({ runner: fr1.runner, bindings: reuse });
    const c1 = collector();
    reuse.set('conn-1', 'team-slack:C1:1.1', 'old-session');

    d1.handleDispatch('conn-1', dispatch(), c1.send);
    await tick();
    expect(c1.last('task.ack')!.payload.sessionId).toBe('old-session');
    fr1.finish({ finalText: '继续' });
    await tick();
    // 正常复用不打扰用户
    expect(c1.last('turn.end')!.payload.finalText).toBe('继续');

    const rebuild = memoryBindings();
    const OUTSIDE = path.resolve('/repos/another-project');
    const fr2 = fakeRunner({ sessions: { 'old-session': { workingDir: OUTSIDE, usable: true } } });
    const { d: d2 } = makeDispatcher({ runner: fr2.runner, bindings: rebuild });
    const c2 = collector();
    rebuild.set('conn-1', 'team-slack:C1:1.1', 'old-session');

    d2.handleDispatch('conn-1', dispatch(), c2.send);
    await tick();
    const sessionId = c2.last('task.ack')!.payload.sessionId!;
    expect(sessionId).not.toBe('old-session');
    expect(fr2.calls[0]).toMatchObject({ isNew: true, workingDir: WS_DIR });
    expect(rebuild.get('conn-1', 'team-slack:C1:1.1')).toBe(sessionId);
    fr2.finish();
  });

  it('绑定的会话已归档/删除 -> 重建并说明是原对话没了', async () => {
    const bindings = memoryBindings();
    const fr = fakeRunner({ sessions: { 'gone-session': { workingDir: WS_DIR, usable: false } } });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    bindings.set('conn-1', 'team-slack:C1:1.1', 'gone-session');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.sessionId).not.toBe('gone-session');

    fr.finish({ finalText: '新的回答' });
    await tick();
    // 措辞留余地: inspect 的 null 也可能是读库瞬时失败, 不能一口咬定会话没了
    expect(c.last('turn.end')!.payload.finalText).toContain('原任务现在读不到');
  });

  it('切账号期间异步定位失败也不回写旧代 rejected ack', async () => {
    let rejectInspect: ((reason: Error) => void) | undefined;
    const runner: HookSessionRunner = {
      isBusy: () => false,
      inspect: () =>
        new Promise((_resolve, reject) => {
          rejectInspect = reject;
        }),
      run: async () => ({
        status: 'ok',
        finalText: 'unused',
        errorMessage: null,
        durationMs: 0,
      }),
    };
    const { d } = makeDispatcher({ runner });
    const c = collector();

    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'stale-inspect', sessionId: 'existing-session' }),
      c.send,
    );
    await tick();
    const draining = d.deactivateAccount();
    rejectInspect?.(new Error('old account DB closed'));
    await draining;

    expect(c.sent).toEqual([]);
  });

  it('externalKey 映射按账号指纹与 provider 隔离，同名 lane 不跨账号复用', async () => {
    const bindings = memoryBindings();
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    const lane = dispatch({ externalKey: 'telegram:dm:bot:user:g0' });

    d.handleDispatch('slack:account-one:telegram', lane, c.send);
    await tick();
    const first = c.last('task.ack')?.payload.sessionId;
    expect(first).toBeTruthy();
    fr.finish();
    await tick();

    d.handleDispatch(
      'slack:account-two:telegram',
      { ...lane, requestId: 'req-account-two' },
      c.send,
    );
    await tick();
    const second = c.last('task.ack')?.payload.sessionId;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(fr.calls).toHaveLength(2);
    fr.finish();
  });

  it('旧 literal Slack 映射仅在当前账号 DB 会话仍可用且在白名单内时迁移', async () => {
    const bindings = memoryBindings();
    bindings.set('slack', 'slack:C1:1.1', 'legacy-session');
    const fr = fakeRunner({
      sessions: { 'legacy-session': { workingDir: WS_DIR, usable: true } },
    });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('slack:account-one:slack', dispatch({ externalKey: 'slack:C1:1.1' }), c.send);
    await tick();
    expect(c.last('task.ack')?.payload.sessionId).toBe('legacy-session');
    expect(fr.calls[0]).toMatchObject({ sessionId: 'legacy-session', isNew: false });
    expect(bindings.get('slack:account-one:slack', 'slack:C1:1.1')).toBe('legacy-session');
    expect(bindings.get('slack', 'slack:C1:1.1')).toBeNull();
    fr.finish();
  });

  it('Telegram 与失效/越界的旧 Slack 映射都不能继承旧账号 session', async () => {
    const bindings = memoryBindings();
    bindings.set('slack', 'shared-key', 'legacy-private-session');
    const fr = fakeRunner({
      sessions: {
        'legacy-private-session': {
          workingDir: path.resolve('/private/other-account'),
          usable: true,
        },
      },
    });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch(
      'slack:account-one:telegram',
      dispatch({ externalKey: 'shared-key', source: { im: 'telegram' } }),
      c.send,
    );
    await tick();
    expect(c.last('task.ack')?.payload.sessionId).not.toBe('legacy-private-session');
    expect(bindings.get('slack', 'shared-key')).toBe('legacy-private-session');
    fr.finish();
    await tick();

    d.handleDispatch(
      'slack:account-one:slack',
      dispatch({ requestId: 'slack-after-telegram', externalKey: 'shared-key' }),
      c.send,
    );
    await tick();
    expect(c.last('task.ack')?.payload.sessionId).not.toBe('legacy-private-session');
    expect(bindings.get('slack', 'shared-key')).toBeNull();
    fr.finish();
  });

  it('幂等: 同 requestId 重投只回放 ack, 不重跑', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();

    expect(c.ofType('task.ack')).toHaveLength(2);
    expect(c.ofType('task.ack')[0].payload).toEqual(c.ofType('task.ack')[1].payload);
    expect(fr.calls).toHaveLength(1);
    fr.finish();
  });

  it('未注册别名 rejected(unknown_workspace); 连接停用 rejected(disabled)', async () => {
    const { d } = makeDispatcher();
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ workspace: 'nope' }), c.send);
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'rejected',
      reason: 'unknown_workspace',
    });

    const { d: d2 } = makeDispatcher({ config: { ...CONFIG, enabled: false } });
    const c2 = collector();
    d2.handleDispatch('conn-1', dispatch(), c2.send);
    await tick();
    expect(c2.last('task.ack')?.payload).toMatchObject({ result: 'rejected', reason: 'disabled' });
  });

  it('对象原型属性不能被当成已配置的 workspace 别名', async () => {
    const { d } = makeDispatcher();
    const c = collector();

    d.handleDispatch('conn-1', dispatch({ workspace: 'constructor' }), c.send);
    await tick();

    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'rejected',
      reason: 'unknown_workspace',
    });
  });

  it('接管: session 存在且在白名单内 -> 复用并重绑; 不存在/越界分别拒绝', async () => {
    const fr = fakeRunner({
      sessions: {
        'sess-in': { workingDir: path.join(WS_DIR, 'sub'), usable: true },
        'sess-out': { workingDir: path.resolve('/private/dir'), usable: true },
        'sess-dead': { workingDir: WS_DIR, usable: false },
      },
    });
    const bindings = memoryBindings();
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();

    d.handleDispatch('conn-1', dispatch({ sessionId: 'sess-in', workspace: null }), c.send);
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({ result: 'accepted', sessionId: 'sess-in' });
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBe('sess-in');
    fr.finish();

    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r2', sessionId: 'sess-out', workspace: null }),
      c.send,
    );
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'rejected',
      reason: 'workspace_not_allowed',
    });

    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r3', sessionId: 'ghost', workspace: null }),
      c.send,
    );
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'rejected',
      reason: 'session_not_found',
    });

    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r4', sessionId: 'sess-dead', workspace: null }),
      c.send,
    );
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'rejected',
      reason: 'session_not_found',
    });
  });

  it('busy 排队: 第二条 queued(位置0), 第一条收口后自动 drain, FIFO', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch({ requestId: 'a' }), c.send);
    await tick();
    d.handleDispatch('conn-1', dispatch({ requestId: 'b' }), c.send);
    await tick();
    d.handleDispatch('conn-1', dispatch({ requestId: 'c' }), c.send);
    await tick();

    const acks = c.ofType('task.ack').map((m) => m.payload);
    expect(acks[0]).toMatchObject({ requestId: 'a', result: 'accepted' });
    expect(acks[1]).toMatchObject({ requestId: 'b', result: 'queued', queuePosition: 0 });
    expect(acks[2]).toMatchObject({ requestId: 'c', result: 'queued', queuePosition: 1 });
    expect(fr.calls).toHaveLength(1);

    fr.finish({ finalText: 'A' });
    await tick();
    expect(fr.calls).toHaveLength(2); // b 自动开跑
    fr.finish({ finalText: 'B' });
    await tick();
    expect(fr.calls).toHaveLength(3);
    fr.finish({ finalText: 'C' });
    await tick();

    const ends = c.ofType('turn.end').map((m) => m.payload);
    expect(ends.map((e) => [e.requestId, e.finalText])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ]);
  });

  it('runner 失败 -> turn.end status=error 且 errorMessage 非空', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    fr.finish({ status: 'error', finalText: '', errorMessage: 'agent 崩了' });
    await tick();
    expect(c.last('turn.end')?.payload).toMatchObject({
      status: 'error',
      errorMessage: 'agent 崩了',
    });
  });

  it('回归: 同 tick 同 key 连发两条 -> 只开一个 session(第二条排队), 铁律不破', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    // 同一同步 tick 内连发(ws 同步 emit 场景) —— 修复前会各开一个新 session
    d.handleDispatch('conn-1', dispatch({ requestId: 'r1' }), c.send);
    d.handleDispatch('conn-1', dispatch({ requestId: 'r2' }), c.send);
    await tick(6);

    const acks = c.ofType('task.ack').map((m) => m.payload);
    expect(acks).toHaveLength(2);
    expect(acks[0]).toMatchObject({ requestId: 'r1', result: 'accepted' });
    expect(acks[1]).toMatchObject({ requestId: 'r2', result: 'queued' });
    expect(acks[1].sessionId).toBe(acks[0].sessionId); // 同一个 session
    expect(fr.calls).toHaveLength(1);
    fr.finish();
    await tick();
    expect(fr.calls).toHaveLength(2); // r2 drain 后仍在同一 session
    expect(fr.calls[1].sessionId).toBe(fr.calls[0].sessionId);
    fr.finish();
  });

  it('回归: 同 tick 同 requestId 重投 -> 只执行一次(in-flight 占位)', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    d.handleDispatch('conn-1', dispatch(), c.send); // ack 尚未回, 修复前会重跑
    await tick(6);

    expect(fr.calls).toHaveLength(1);
    expect(c.ofType('task.ack')).toHaveLength(1); // 重投被忽略, 首条 ack 即应答
    fr.finish();
  });

  it('队列溢出: 超过上限打回 rejected(invalid)', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch({ requestId: 'run' }), c.send);
    await tick();
    for (let i = 0; i < 21; i++) {
      d.handleDispatch('conn-1', dispatch({ requestId: `q${i}` }), c.send);
      await tick();
    }
    const acks = c.ofType('task.ack').map((m) => m.payload);
    const overflow = acks[acks.length - 1];
    expect(acks.filter((a) => a.result === 'queued')).toHaveLength(20);
    expect(overflow).toMatchObject({ requestId: 'q20', result: 'rejected', reason: 'invalid' });
    fr.finish();
  });

  it('onDisconnected 后不再写旧 socket，turn.end 在重连后按序补发', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    d.onDisconnected('conn-1'); // 收口前 transport 断线，旧 send 本身仍会返回 true
    fr.finish({ finalText: '离线结果' });
    await tick();
    expect(c.ofType('turn.end')).toHaveLength(0);

    const c2 = collector();
    d.onConnected('conn-1', c2.send);
    expect(c2.last('turn.end')?.payload).toMatchObject({ finalText: '离线结果' });
  });
});

describe('worktree 并发隔离(prepareWorktree)', () => {
  it('账号切换发生在异步预建期间时回收 worktree，且不写旧代 binding/ack', async () => {
    const fr = fakeRunner();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    let resolvePrepare:
      | ((value: {
          ok: true;
          sessionId: string;
          path: string;
          cleanup: () => Promise<void>;
        }) => void)
      | undefined;
    const { d, bindings } = makeDispatcher({
      runner: fr.runner,
      prepareWorktree: () =>
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
    });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(resolvePrepare).toBeTypeOf('function');
    const draining = d.deactivateAccount();
    resolvePrepare?.({
      ok: true,
      sessionId: 'stale-worktree',
      path: path.join(WS_DIR, '.xdt-worktrees', 'stale'),
      cleanup,
    });
    await draining;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBeNull();
    expect(c.ofType('task.ack')).toHaveLength(0);
    expect(fr.calls).toHaveLength(0);
  });

  it('新建会话: 预建成功 -> 用 worktree 的 sessionId 与路径, binding 记同一 id', async () => {
    const fr = fakeRunner();
    const wt = path.join(WS_DIR, '.xdt-worktrees', 'wt-1');
    const calls: string[] = [];
    const { d, bindings } = makeDispatcher({
      runner: fr.runner,
      prepareWorktree: async (dir) => {
        calls.push(dir);
        return { ok: true, sessionId: 'wt-session-1', path: wt, cleanup: async () => {} };
      },
    });
    const c = collector();
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();

    expect(calls).toEqual([WS_DIR]); // 以别名目录为 base 解析
    const ack = c.last('task.ack')!.payload;
    expect(ack.result).toBe('accepted');
    expect(ack.sessionId).toBe('wt-session-1');
    expect(bindings.get('conn-1', 'team-slack:C1:1.1')).toBe('wt-session-1');
    expect(fr.calls[0]).toMatchObject({ isNew: true, sessionId: 'wt-session-1', workingDir: wt });
    fr.finish();
  });

  it('预建失败 -> 回退共享工作区目录, 照常派发', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({
      runner: fr.runner,
      prepareWorktree: async () => ({ ok: false, message: 'not a git repo' }),
    });
    const c = collector();
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.result).toBe('accepted');
    expect(fr.calls[0]).toMatchObject({ isNew: true, workingDir: WS_DIR });
    fr.finish();
  });

  it('worktree 路径越界(不在别名目录内)-> 回退共享目录 + 回收孤儿 worktree', async () => {
    const fr = fakeRunner();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { d } = makeDispatcher({
      runner: fr.runner,
      prepareWorktree: async () => ({
        ok: true,
        sessionId: 'escaped',
        path: path.resolve('/repos/elsewhere/.xdt-worktrees/x'),
        cleanup,
      }),
    });
    const c = collector();
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.sessionId).not.toBe('escaped');
    expect(fr.calls[0]).toMatchObject({ isNew: true, workingDir: WS_DIR });
    expect(cleanup).toHaveBeenCalledTimes(1);
    fr.finish();
  });

  it('同 key 复用不再预建; 不同 key 各得独立 worktree(并发隔离本体)', async () => {
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    let n = 0;
    const { d } = makeDispatcher({
      runner: fr.runner,
      prepareWorktree: async () => {
        n += 1;
        return {
          ok: true,
          sessionId: `wt-s-${n}`,
          path: path.join(WS_DIR, '.xdt-worktrees', `wt-${n}`),
          cleanup: async () => {},
        };
      },
    });
    const c = collector();
    // thread A 开场
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r1', externalKey: 'team-slack:C1:a' }),
      c.send,
    );
    await tick();
    // thread B 开场(A 还在跑)—— 并发, 各自 worktree
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r2', externalKey: 'team-slack:C1:b' }),
      c.send,
    );
    await tick();
    expect(n).toBe(2);
    expect(fr.calls[0]).toMatchObject({
      sessionId: 'wt-s-1',
      workingDir: path.join(WS_DIR, '.xdt-worktrees', 'wt-1'),
    });
    expect(fr.calls[1]).toMatchObject({
      sessionId: 'wt-s-2',
      workingDir: path.join(WS_DIR, '.xdt-worktrees', 'wt-2'),
    });
    // 两个都 accepted(不同 session 真并发, 不互相排队)
    expect(c.ofType('task.ack').map((a) => a.payload.result)).toEqual(['accepted', 'accepted']);

    // thread A 续写: 复用绑定 session, 不再预建
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r3', externalKey: 'team-slack:C1:a' }),
      c.send,
    );
    await tick();
    expect(n).toBe(2); // 未新增预建
    expect(c.last('task.ack')!.payload).toMatchObject({ result: 'queued', sessionId: 'wt-s-1' });
    fr.finish();
    fr.finish();
  });
});

describe('task.cancel(/stop)', () => {
  it('排队中的任务: 摘除并立即回 turn.end(cancelled)', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ requestId: 'r1', externalKey: 'slack:C1:a' }), c.send);
    await tick();
    // 同 key 第二条排队
    d.handleDispatch('conn-1', dispatch({ requestId: 'r2', externalKey: 'slack:C1:a' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload).toMatchObject({ requestId: 'r2', result: 'queued' });

    d.cancel('conn-1', 'r2');
    await tick();
    const ends = c.ofType('turn.end');
    expect(ends).toHaveLength(1);
    expect(ends[0].payload).toMatchObject({
      requestId: 'r2',
      status: 'cancelled',
      errorMessage: null,
    });

    // r1 正常收口, 且不受 r2 取消影响
    fr.finish();
    await tick();
    expect(c.ofType('turn.end').map((e) => e.payload.requestId)).toEqual(['r2', 'r1']);
    expect(fr.pendingCount()).toBe(0);
  });

  it('执行中的任务: abortSession 被调, 收口结果改写为 cancelled', async () => {
    const fr = fakeRunner();
    const aborted: string[] = [];
    const bindings = memoryBindings();
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      abortSession: async (sessionId) => {
        aborted.push(sessionId);
        // 模拟 abort 后 runner 以 error 收口(SDK 中断常见形态)
        fr.finish({ status: 'error', errorMessage: 'interrupted', finalText: '部分产出' });
      },
      log: noopLog,
    });
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ requestId: 'r1', externalKey: 'slack:C1:a' }), c.send);
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId as string;

    d.cancel('conn-1', 'r1');
    await tick();
    expect(aborted).toEqual([sessionId]);
    const end = c.last('turn.end')!.payload;
    // 对上游统一报 cancelled(abort 导致的 error 不是真错误), errorMessage 必须为 null
    expect(end).toMatchObject({
      requestId: 'r1',
      status: 'cancelled',
      errorMessage: null,
      finalText: '部分产出',
    });
  });

  it('不同 provider 的相同 requestId 各自取消，不会中断另一条任务', async () => {
    const fr = fakeRunner();
    const aborted: string[] = [];
    const { d } = makeDispatcher({
      runner: fr.runner,
      abortSession: async (sessionId) => void aborted.push(sessionId),
    });
    const slack = collector();
    const telegram = collector();
    const requestId = 'provider-shared-request-id';

    d.handleDispatch(
      'account:slack',
      dispatch({ requestId, externalKey: 'slack:C1:root' }),
      slack.send,
    );
    d.handleDispatch(
      'account:telegram',
      dispatch({ requestId, externalKey: 'telegram:dm:bot:user:g0' }),
      telegram.send,
    );
    await tick();

    const slackSessionId = slack.last('task.ack')?.payload.sessionId;
    const telegramSessionId = telegram.last('task.ack')?.payload.sessionId;
    expect(slackSessionId).toEqual(expect.any(String));
    expect(telegramSessionId).toEqual(expect.any(String));
    expect(slackSessionId).not.toBe(telegramSessionId);

    d.cancel('account:slack', requestId);
    await tick();
    expect(aborted).toEqual([slackSessionId]);

    fr.finish({ finalText: 'slack stopped' });
    fr.finish({ finalText: 'telegram done' });
    await tick();
    expect(slack.last('turn.end')?.payload).toMatchObject({
      requestId,
      status: 'cancelled',
    });
    expect(telegram.last('turn.end')?.payload).toMatchObject({
      requestId,
      status: 'ok',
    });
  });

  it('未知 / 已收口的 requestId: 静默忽略', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ requestId: 'r1', externalKey: 'slack:C1:a' }), c.send);
    await tick();
    fr.finish();
    await tick();
    expect(() => d.cancel('conn-1', 'r1')).not.toThrow(); // 已收口
    expect(() => d.cancel('conn-1', 'nope')).not.toThrow(); // 未知
    expect(c.ofType('turn.end')).toHaveLength(1); // 没有额外帧
  });
});

describe('options 透传(model/effort/agentKind/permissionMode)', () => {
  it('dispatch options 原样进 HookRunRequest; 缺省为 null', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();
    d.handleDispatch(
      'conn-1',
      dispatch({
        requestId: 'r1',
        externalKey: 'slack:C1:a',
        options: {
          model: 'claude-opus-4-8',
          effort: 'high',
          agentKind: 'claude-code',
          permissionMode: 'ask',
        },
      }),
      c.send,
    );
    await tick();
    expect(fr.calls[0]).toMatchObject({
      model: 'claude-opus-4-8',
      effort: 'high',
      agentKind: 'claude-code',
      permissionMode: 'ask',
    });
    d.handleDispatch('conn-1', dispatch({ requestId: 'r2', externalKey: 'slack:C1:b' }), c.send);
    await tick();
    expect(fr.calls[1]).toMatchObject({
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
    });
    fr.finish();
    fr.finish();
  });
});

describe('session.archive(/new 换代归档旧代会话)', () => {
  it('安全接管旧 Slack 命名空间映射；跨白名单映射只清理不归档', async () => {
    const safeSession = 'legacy-safe';
    const unsafeSession = 'legacy-unsafe';
    const safeKey = 'slack:dm:T1:U1:g1';
    const unsafeKey = 'slack:dm:T1:U1:g2';
    const fr = fakeRunner({
      sessions: {
        [safeSession]: { workingDir: WS_DIR, usable: true },
        [unsafeSession]: { workingDir: path.resolve('/repos/other'), usable: true },
      },
    });
    const bindings = memoryBindings();
    bindings.set('slack', safeKey, safeSession);
    bindings.set('slack', unsafeKey, unsafeSession);
    const archived: string[] = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      archiveSessionRow: async (sessionId) => void archived.push(sessionId),
      log: noopLog,
    });

    d.handleSessionArchive('slack:account-fingerprint:slack', safeKey);
    d.handleSessionArchive('slack:account-fingerprint:slack', unsafeKey);
    await tick();

    expect(archived).toEqual([safeSession]);
    expect(bindings.get('slack', safeKey)).toBeNull();
    expect(bindings.get('slack', unsafeKey)).toBeNull();
  });

  it('有绑定: 归档 session 行并清绑定', async () => {
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const bindings = memoryBindings();
    const archived: string[] = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      archiveSessionRow: async (sessionId) => void archived.push(sessionId),
      log: noopLog,
    });
    const c = collector();
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r1', externalKey: 'slack:dm:U1:g1' }),
      c.send,
    );
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId as string;
    sessions[sessionId] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    d.handleSessionArchive('conn-1', 'slack:dm:U1:g1');
    await tick();
    expect(archived).toEqual([sessionId]);
    expect(bindings.get('conn-1', 'slack:dm:U1:g1')).toBeNull();
  });

  it('turn 还在跑但已落库时被移出映射: /new 也不归档(不走 awaitingPersist 捷径)', async () => {
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const bindings = memoryBindings();
    const archived: string[] = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      archiveSessionRow: async (sessionId) => void archived.push(sessionId),
      log: noopLog,
    });
    const c = collector();
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r1', externalKey: 'slack:dm:U1:g1' }),
      c.send,
    );
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId as string;
    // 关键: turn 没收口, 所以 awaitingPersist 里还留着它 —— 但它已经落库, 且
    // 已被移出映射。捷径必须只在"真查不到"时才用。
    sessions[sessionId] = { workingDir: path.resolve('/repos/elsewhere'), usable: true };

    d.handleSessionArchive('conn-1', 'slack:dm:U1:g1');
    await tick();
    expect(archived).toEqual([]);
    expect(bindings.get('conn-1', 'slack:dm:U1:g1')).toBeNull();
    fr.finish();
  });

  it('会话已被移出映射: /new 只清绑定, 不归档那个本地会话', async () => {
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const bindings = memoryBindings();
    const archived: string[] = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      archiveSessionRow: async (sessionId) => void archived.push(sessionId),
      log: noopLog,
    });
    const c = collector();
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r1', externalKey: 'slack:dm:U1:g1' }),
      c.send,
    );
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId as string;
    fr.finish();
    await tick();
    // 用户把它移到映射外 —— 远端已经无权驱动它, 也就无权归档它 / 触发它的
    // worktree 清理
    sessions[sessionId] = { workingDir: path.resolve('/repos/elsewhere'), usable: true };

    d.handleSessionArchive('conn-1', 'slack:dm:U1:g1');
    await tick();
    expect(archived).toEqual([]);
    // 绑定还是要清: 下条消息本就该开新会话
    expect(bindings.get('conn-1', 'slack:dm:U1:g1')).toBeNull();
  });

  it('无绑定: 幂等 no-op; 归档失败(行不存在)只吞不抛', async () => {
    const fr = fakeRunner();
    const bindings = memoryBindings();
    bindings.set('conn-1', 'slack:dm:U1:g2', 'sess-gone');
    const archiveCalls: string[] = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      archiveSessionRow: async (sessionId) => {
        archiveCalls.push(sessionId);
        throw new Error('[NOT_FOUND] Session 不存在');
      },
      log: noopLog,
    });
    // 无绑定 key: 不触发归档
    d.handleSessionArchive('conn-1', 'slack:dm:U1:g1');
    await tick();
    expect(archiveCalls).toEqual([]);
    // 有绑定但会话查不到(行已不存在): 无从确认它还在映射内, 就不对它动手 ——
    // 反正 archiveSessionRow 也只会 NOT_FOUND。绑定照清, 幂等目的达到。
    d.handleSessionArchive('conn-1', 'slack:dm:U1:g2');
    await tick();
    expect(archiveCalls).toEqual([]);
    expect(bindings.get('conn-1', 'slack:dm:U1:g2')).toBeNull();
  });

  it('与同 key dispatch 串行: 归档能看到在途派发刚落下的绑定', async () => {
    const fr = fakeRunner();
    const bindings = memoryBindings();
    const archived: string[] = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      archiveSessionRow: async (sessionId) => void archived.push(sessionId),
      log: noopLog,
    });
    const c = collector();
    // 同 tick 连发: dispatch(会新建会话落绑定)后紧跟 archive —— serializeByKey
    // 保证 archive 排在定位之后, 不会因绑定尚未落下而漏归档
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r1', externalKey: 'slack:dm:U1:g1' }),
      c.send,
    );
    d.handleSessionArchive('conn-1', 'slack:dm:U1:g1');
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId as string;
    expect(archived).toEqual([sessionId]);
    expect(bindings.get('conn-1', 'slack:dm:U1:g1')).toBeNull();
    fr.finish();
  });
});

describe('turn.progress 进度快照', () => {
  it('execute 给 runner 注入 onProgress, 调用即发 turn.progress 帧(带本任务 requestId)', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const onProgress = fr.calls[0].onProgress;
    expect(onProgress).toBeTypeOf('function');

    onProgress!('⚙️ 第 1 步 · 3s\n> ▸ Bash pnpm test');
    const frames = c.ofType('turn.progress');
    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual({
      requestId: 'req-1',
      text: '⚙️ 第 1 步 · 3s\n> ▸ Bash pnpm test',
    });

    fr.finish();
    await tick();
  });

  it('连接离线时进度帧直接丢弃(不缓存不补发, 与 turn.end 的离线缓存相反)', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    c.setOnline(false);
    fr.calls[0].onProgress!('进行中…');
    expect(c.ofType('turn.progress')).toHaveLength(0);

    // 收口后重连: 只补发 turn.end, 不出现任何积压的 progress
    fr.finish();
    await tick();
    c.setOnline(true);
    d.onConnected('conn-1', c.send);
    expect(c.ofType('turn.progress')).toHaveLength(0);
    expect(c.ofType('turn.end')).toHaveLength(1);
  });
});

describe('interaction.decision 路由', () => {
  it('归属校验通过 -> 调 resolveInteraction; 未知/他连接的 requestId 忽略', async () => {
    const fr = fakeRunner();
    const bindings = memoryBindings();
    const resolved: Array<{ interactionId: string; buttonId: string }> = [];
    const d = createHookDispatcher({
      getConnection: () => CONFIG,
      bindings,
      runner: fr.runner,
      resolveInteraction: (interactionId, buttonId) => {
        resolved.push({ interactionId, buttonId });
        return true;
      },
      log: noopLog,
    });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();

    // 执行中的任务: 决策放行
    d.handleInteractionDecision('conn-1', {
      requestId: 'req-1',
      interactionId: 'int-1',
      buttonId: 'ask:0',
    });
    expect(resolved).toEqual([{ interactionId: 'int-1', buttonId: 'ask:0' }]);

    // 其它连接冒充 / 未知任务: 忽略
    d.handleInteractionDecision('conn-evil', {
      requestId: 'req-1',
      interactionId: 'int-1',
      buttonId: 'ask:0',
    });
    d.handleInteractionDecision('conn-1', {
      requestId: 'req-nope',
      interactionId: 'int-2',
      buttonId: 'ask:0',
    });
    expect(resolved).toHaveLength(1);

    // 收口后: runningByRequest 已清, 迟到决策忽略
    fr.finish();
    await tick();
    d.handleInteractionDecision('conn-1', {
      requestId: 'req-1',
      interactionId: 'int-1',
      buttonId: 'ask:0',
    });
    expect(resolved).toHaveLength(1);
  });

  it('execute 注入 onInteraction/onInteractionCancel, 调用即发对应帧', async () => {
    const fr = fakeRunner();
    const { d } = makeDispatcher({ runner: fr.runner });
    const c = collector();

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const req = fr.calls[0];
    req.onInteraction!({
      interactionId: 'int-1',
      kind: 'ask_user_question',
      title: '❓ 问题',
      body: '',
      buttons: [{ id: 'ask:0', label: 'A', style: 'default' }],
    });
    req.onInteractionCancel!('int-1', '等待超时');

    const reqFrame = c.last('interaction.request');
    expect(reqFrame?.payload).toMatchObject({ requestId: 'req-1', interactionId: 'int-1' });
    const cancelFrame = c.last('interaction.cancel');
    expect(cancelFrame?.payload).toEqual({
      requestId: 'req-1',
      interactionId: 'int-1',
      reason: '等待超时',
    });
    fr.finish();
  });
});

describe('内置「对话」伪目录(chat 保留别名)', () => {
  const DIALOGUE_ROOT = path.resolve('/userdata/dialogues');
  function dialogueDep() {
    const allocated: string[] = [];
    return {
      allocated,
      dep: {
        rootDir: () => DIALOGUE_ROOT,
        allocateDir: async (sessionId: string) => {
          const dir = path.join(DIALOGUE_ROOT, '2026-07-07', sessionId);
          allocated.push(dir);
          return dir;
        },
      },
    };
  }

  it('chat 新建: 分配对话目录、不做 worktree、workspaceKind=dialogue、ack accepted', async () => {
    const dd = dialogueDep();
    const prepareWorktree = vi.fn();
    const { d, fr } = makeDispatcher({ dialogue: dd.dep, prepareWorktree });
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ workspace: 'chat' }), c.send);
    await tick();
    expect(c.last('task.ack')?.payload.result).toBe('accepted');
    expect(fr.calls).toHaveLength(1);
    const req = fr.calls[0];
    expect(req.isNew).toBe(true);
    expect(req.workspaceKind).toBe('dialogue');
    expect(dd.allocated).toEqual([req.workingDir]);
    expect(isPathWithin(DIALOGUE_ROOT, req.workingDir)).toBe(true);
    expect(prepareWorktree).not.toHaveBeenCalled();
    fr.finish();
  });

  it('chat 同 externalKey 复用同 session(重校验容忍对话根内路径)', async () => {
    const dd = dialogueDep();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ dialogue: dd.dep, runner: fr.runner });
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ requestId: 'r1', workspace: 'chat' }), c.send);
    await tick();
    const first = fr.calls[0];
    fr.finish();
    await tick();
    // 会话已落库(inspect 可查), workingDir 在对话根内
    sessions[first.sessionId] = { workingDir: first.workingDir, usable: true };
    d.handleDispatch('conn-1', dispatch({ requestId: 'r2', workspace: 'chat' }), c.send);
    await tick();
    expect(fr.calls).toHaveLength(2);
    expect(fr.calls[1].sessionId).toBe(first.sessionId);
    expect(fr.calls[1].isNew).toBe(false);
    fr.finish();
  });

  it('接管对话根内的会话: 白名单外但在 dialogues 根内 -> 放行', async () => {
    const dd = dialogueDep();
    const fr = fakeRunner({
      sessions: {
        'sess-dlg': {
          workingDir: path.join(DIALOGUE_ROOT, '2026-07-01', 'sess-dlg'),
          usable: true,
        },
      },
    });
    const { d } = makeDispatcher({ dialogue: dd.dep, runner: fr.runner });
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ workspace: null, sessionId: 'sess-dlg' }), c.send);
    await tick();
    expect(c.last('task.ack')?.payload.result).toBe('accepted');
    fr.finish();
  });

  it('dispatcher 创建后切换 owner 时按新的对话根校验接管会话', async () => {
    const signedOutRoot = path.resolve('/userdata/cindy-no-session/123/dialogues');
    const cloudRoot = path.resolve('/userdata/owners/cloud-a/dialogues');
    let activeRoot = signedOutRoot;
    const fr = fakeRunner({
      sessions: {
        'sess-cloud': {
          workingDir: path.join(cloudRoot, '2026-07-22', 'sess-cloud'),
          usable: true,
        },
      },
    });
    const { d } = makeDispatcher({
      dialogue: {
        rootDir: () => activeRoot,
        allocateDir: async (sessionId) => path.join(activeRoot, '2026-07-22', sessionId),
      },
      runner: fr.runner,
    });
    activeRoot = cloudRoot;

    const c = collector();
    d.handleDispatch('conn-1', dispatch({ workspace: null, sessionId: 'sess-cloud' }), c.send);
    await tick();

    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'accepted',
      sessionId: 'sess-cloud',
    });
    fr.finish();
  });

  it('未注入 dialogue dep: chat 别名按 unknown_workspace 拒绝(旧行为默认)', async () => {
    const { d } = makeDispatcher();
    const c = collector();
    d.handleDispatch('conn-1', dispatch({ workspace: 'chat' }), c.send);
    await tick();
    expect(c.last('task.ack')?.payload).toMatchObject({
      result: 'rejected',
      reason: 'unknown_workspace',
    });
  });
});

describe('turn.reopen: 失败任务在桌面端被续跑后接回原消息', () => {
  /**
   * 可控续跑观察器: 记录 watch 请求, 由测试驱动 claim / progress / end。
   * sessions 是可变的 —— 测试可在首轮之后把会话登记进去, 让后续 dispatch 走
   * 「binding 复用同一个 session」而不是查不到重建。
   */
  function continuationRunner() {
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const watches: HookContinuationWatchRequest[] = [];
    const cancels: number[] = [];
    const runner: HookSessionRunner = {
      ...fr.runner,
      watchContinuation: (req) => {
        watches.push(req);
        const index = watches.length - 1;
        // 真实 runner 现在**立即认领**: 归属已由 clientId 在 dispatch 前确认, 不再等
        // 首个事件来猜这一轮是不是目标轮(见 uiContinuationSignal)。fixture 照此模拟,
        // 否则用例会测一个生产上不存在的"已挂未认领"中间态。
        req.onClaim();
        return () => cancels.push(index);
      },
    };
    return {
      ...fr,
      runner,
      sessions,
      watches,
      cancels,
      latest: () => watches[watches.length - 1],
    };
  }

  /**
   * 信号源: 模拟 coordinator 侧那四条通道。
   *
   * 归属键是 clientId —— 续跑意图(fire)与"那条消息即将 dispatch"(dispatchTurn)必须带
   * 同一个 clientId 才算同一轮, 这正是本 PR 用来替掉"首个事件 + isBusy 快照"的东西。
   */
  function signalSource() {
    const retryListeners = new Set<(sessionId: string, clientId: string) => void>();
    const dispatchListeners = new Set<(sessionId: string, clientId: string) => void>();
    const undispatchListeners = new Set<(sessionId: string, clientId: string) => void>();
    const interveners = new Set<(sessionId: string) => void>();
    return {
      subscribe: ((listener) => {
        retryListeners.add(listener);
        return () => retryListeners.delete(listener);
      }) as NonNullable<HookDispatcherDeps['subscribeUiContinuation']>,
      subscribeIntervention: ((listener) => {
        interveners.add(listener);
        return () => interveners.delete(listener);
      }) as NonNullable<HookDispatcherDeps['subscribeUiSessionIntervention']>,
      subscribeDispatching: ((listener) => {
        dispatchListeners.add(listener);
        return () => dispatchListeners.delete(listener);
      }) as NonNullable<HookDispatcherDeps['subscribeUiTurnDispatching']>,
      subscribeUndispatched: ((listener) => {
        undispatchListeners.add(listener);
        return () => undispatchListeners.delete(listener);
      }) as NonNullable<HookDispatcherDeps['subscribeUiTurnUndispatched']>,
      /** 模拟"桌面端在这个任务里做了与续跑无关的事"。 */
      intervene: (sessionId: string) => {
        for (const l of [...interveners]) l(sessionId);
      },
      /** 用户点了重试 —— 只是意图, 还没确定是哪一轮。 */
      fire: (sessionId: string, clientId = DEFAULT_RETRY_CLIENT_ID) => {
        for (const l of [...retryListeners]) l(sessionId, clientId);
      },
      /** 那条消息即将 vendor dispatch —— 归属在这一刻成立。 */
      dispatchTurn: (sessionId: string, clientId = DEFAULT_RETRY_CLIENT_ID) => {
        for (const l of [...dispatchListeners]) l(sessionId, clientId);
      },
      /** 那条消息落库了却没能 dispatch。 */
      undispatchTurn: (sessionId: string, clientId = DEFAULT_RETRY_CLIENT_ID) => {
        for (const l of [...undispatchListeners]) l(sessionId, clientId);
      },
      /**
       * 走完整一轮续跑: 意图 + 归属确认。绝大多数用例只关心"续跑接上了没有",
       * 用它即可; 只有专门验证两阶段语义的用例才分开调 fire / dispatchTurn。
       */
      retry: (sessionId: string, clientId = DEFAULT_RETRY_CLIENT_ID) => {
        for (const l of [...retryListeners]) l(sessionId, clientId);
        for (const l of [...dispatchListeners]) l(sessionId, clientId);
      },
      /** 当前订阅数 —— 用于直接断言 dispose 真的退订了。 */
      listenerCount: () => retryListeners.size,
    };
  }

  /** 绝大多数用例只关心"同一轮", 用同一个 clientId 即可。 */
  const DEFAULT_RETRY_CLIENT_ID = 'retry-client-id';

  const REOPEN_FEATURES = [HOOK_FEATURE_TURN_REOPEN];

  /** 跑一个 hook 任务并让它以失败收口, 返回环境与那一轮的 sessionId。 */
  async function failOneTask(opts?: { features?: readonly string[] }) {
    const cr = continuationRunner();
    const sig = signalSource();
    const c = collector();
    const { d } = makeDispatcher({
      runner: cr.runner,
      subscribeUiContinuation: sig.subscribe,
      subscribeUiSessionIntervention: sig.subscribeIntervention,
      subscribeUiTurnDispatching: sig.subscribeDispatching,
      subscribeUiTurnUndispatched: sig.subscribeUndispatched,
    });
    d.onConnected('conn-1', c.send, opts?.features ?? REOPEN_FEATURES);
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId!;
    cr.finish({ status: 'error', finalText: '', errorMessage: 'boom' });
    await tick();
    expect(c.last('turn.end')!.payload.status).toBe('error');
    return { cr, sig, c, d, sessionId };
  }

  it('续跑信号 -> turn.reopen(新 requestId + reopenOf) -> 进度与结果都走新 id', async () => {
    const { cr, sig, c, sessionId } = await failOneTask();

    // 意图到达时**还不**挂观察、不发帧: 归属要等那条消息真的要 dispatch 才成立。
    sig.fire(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);

    // 归属确认(clientId 对得上)-> 挂观察 + 立即认领 + 发 reopen。
    sig.dispatchTurn(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(cr.latest().sessionId).toBe(sessionId);
    expect(c.ofType('turn.reopen')).toHaveLength(1);

    const reopen = c.last('turn.reopen')!.payload;
    expect(reopen.reopenOf).toBe('req-1');
    expect(reopen.requestId).not.toBe('req-1');
    expect(reopen.externalKey).toBe('team-slack:C1:1.1');
    expect(reopen.sessionId).toBe(sessionId);
    expect(reopen.reason).toBe('user-continued');

    cr.latest().onProgress('干到一半了');
    expect(c.last('turn.progress')!.payload).toEqual({
      requestId: reopen.requestId,
      text: '干到一半了',
    });

    cr.latest().onEnd({
      status: 'ok',
      finalText: '这次成了',
      errorMessage: null,
      durationMs: 12,
    });
    const end = c.ofType('turn.end').at(-1)!.payload;
    expect(end.requestId).toBe(reopen.requestId);
    expect(end.status).toBe('ok');
    expect(end.finalText).toBe('这次成了');
    // 原 requestId 的那条 turn.end 仍然只有一条(server 侧幂等语义不变)。
    expect(c.ofType('turn.end').filter((m) => m.payload.requestId === 'req-1')).toHaveLength(1);
  });

  it('server 没宣告 turn-reopen 能力时完全不启用(不记账, 信号空转)', async () => {
    const { cr, sig, c, sessionId } = await failOneTask({ features: [] });
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);
  });

  it('只有 error 收口才记账: ok 与 cancelled 都不接回', async () => {
    for (const outcome of [
      { status: 'ok' as const, finalText: 'done', errorMessage: null },
      { status: 'error' as const, finalText: '', errorMessage: 'x' }, // cancelled 走 cancel() 改写
    ]) {
      const cr = continuationRunner();
      const sig = signalSource();
      const c = collector();
      const { d } = makeDispatcher({ runner: cr.runner, subscribeUiContinuation: sig.subscribe });
      d.onConnected('conn-1', c.send, REOPEN_FEATURES);
      d.handleDispatch('conn-1', dispatch(), c.send);
      await tick();
      const sessionId = c.last('task.ack')!.payload.sessionId!;
      if (outcome.status === 'error') {
        // 用户按了停止 -> 上游看到的是 cancelled, 不该被当成"失败等续跑"。
        d.cancel('conn-1', 'req-1');
      }
      cr.finish({ ...outcome, durationMs: 1 });
      await tick();
      sig.retry(sessionId);
      await tick();
      expect(c.ofType('turn.reopen')).toHaveLength(0);
      expect(cr.watches).toHaveLength(0);
    }
  });

  it('同 session 又来了新的 hook 任务 -> 撤销在观察的续跑并作废记账', async () => {
    const { cr, sig, c, d, sessionId } = await failOneTask();
    // 让后续 dispatch 沿 binding 落回同一个任务(否则 inspect 查不到会重建)。
    cr.sessions[sessionId] = { workingDir: WS_DIR, usable: true };
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);

    // 新任务接管这条消息线: 旧观察器必须被撤销, 否则新 turn 的事件会被当成
    // 续跑的继续, 把上一条渠道消息改写成不相干的内容。
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(cr.cancels).toEqual([0]);

    // 记账也作废: 再来一次续跑信号不会重开旧消息。
    cr.finish({ status: 'error', finalText: '', errorMessage: 'again' });
    await tick();
    sig.retry(sessionId);
    await tick();
    // 新一轮(req-2)自己失败后重新记账, 于是这次接回的是 req-2 那条消息。
    expect(cr.watches).toHaveLength(2);
    expect(c.ofType('turn.reopen').at(-1)!.payload.reopenOf).toBe('req-2');
  });

  it('接管导致的撤销不留新记账(否则续跑会把用户带回一条过期消息)', async () => {
    const { cr, sig, c, d, sessionId } = await failOneTask();
    cr.sessions[sessionId] = { workingDir: WS_DIR, usable: true };
    sig.retry(sessionId);
    await tick();

    // 新任务接管 -> 撤销续跑。撤销的收口是 error, 但这条消息线已经归新任务了。
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(cr.cancels).toEqual([0]);

    // 新任务成功收口 -> 全程没有任何"等着被续跑"的东西。
    cr.finish({ status: 'ok', finalText: '这次好了', errorMessage: null });
    await tick();
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('目标那条消息始终没能 dispatch -> 不发任何帧, 记账还回去让下次重试还能接上', async () => {
    // 取消 / 派发失败(凭证切换被放弃、队列被清等)。渠道那条消息**没被改写过**, 所以
    // 记账仍然有效 —— 不还回去, 回流就永久丢了, 而这正是本能力要修的症状。
    // 这里也是"慢启动"的收口方式: 意图可以等任意长时间(远端 SSH 重连、凭证切换都在
    // dispatch 之前), 不再有任何固定窗口会把它提前判死。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.fire(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);

    sig.undispatchTurn(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(0);
    expect(c.ofType('turn.end').filter((m) => m.payload.requestId !== 'req-1')).toHaveLength(0);

    // 记账已还回去: 用户再点一次重试, 照样能接上。
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('新任务接管导致的撤销不还记账(那条消息线已交给别人)', async () => {
    // 与"目标轮没能 dispatch"那条的区别: 那条该还记账(用户马上会再点重试), 这条不该
    // (消息线已经交给新任务, 还了会让之后的续跑信号把用户带回一条过期消息)。
    // 撤销后 runner 按契约收口 —— 已认领的走 onEnd, 而它不得据此重新登记。
    const { cr, sig, c, d, sessionId } = await failOneTask();
    cr.sessions[sessionId] = { workingDir: WS_DIR, usable: true };
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    expect(cr.cancels).toEqual([0]);
    cr.watches[0]!.onEnd({
      status: 'error',
      finalText: '',
      errorMessage: 'hook continuation cancelled',
      durationMs: 1,
    });
    await tick();

    // 新任务成功收口后再来一次续跑信号: 不该有任何"等着被续跑"的记账复活。
    cr.finish({ status: 'ok', finalText: '这次好了', errorMessage: null });
    await tick();
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
  });

  it('续跑又失败 -> 允许再续一次, reopenOf 指向上一轮的新 id(成链)', async () => {
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    const firstReopen = c.last('turn.reopen')!.payload.requestId;
    cr.latest().onEnd({
      status: 'error',
      finalText: '',
      errorMessage: '又崩了',
      durationMs: 3,
    });
    await tick();

    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(2);
    const secondReopen = c.ofType('turn.reopen').at(-1)!.payload;
    expect(secondReopen.reopenOf).toBe(firstReopen);
    expect(secondReopen.requestId).not.toBe(firstReopen);
  });

  it('认领后连接断开 -> 续跑轮的 turn.end 不缓存不补发, 也不再登记可续跑', async () => {
    const { cr, sig, c, d, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    const reopened = c.last('turn.reopen')!.payload.requestId;
    const endsBefore = c.ofType('turn.end').length;

    // 映射已装上、渠道消息已改成进行中, 此时断连: server 侧会做孤儿收口并解绑
    // 这一轮的 requestId, 所以迟到的 turn.end 只会被当未知 id 丢弃。
    d.onDisconnected('conn-1');
    cr.latest().onEnd({ status: 'error', finalText: '', errorMessage: '又崩了', durationMs: 3 });
    await tick();
    expect(c.ofType('turn.end')).toHaveLength(endsBefore);

    // 重连不得把它补发出来(普通任务才走 sendOrBuffer 的断线补发)。
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    await tick();
    expect(c.ofType('turn.end').filter((m) => m.payload.requestId === reopened)).toHaveLength(0);

    // 也不得再登记可续跑: 那条记账的 reopenOf 已被 server 解绑, 再发只会被忽略。
    const reopensBefore = c.ofType('turn.reopen').length;
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(c.ofType('turn.reopen')).toHaveLength(reopensBefore);
  });

  it('续跑轮可被 /stop 精确取消(新 requestId 已登记为在执行的任务)', async () => {
    const aborted: string[] = [];
    const cr = continuationRunner();
    const sig = signalSource();
    const c = collector();
    const { d } = makeDispatcher({
      runner: cr.runner,
      subscribeUiContinuation: sig.subscribe,
      subscribeUiTurnDispatching: sig.subscribeDispatching,
      subscribeUiTurnUndispatched: sig.subscribeUndispatched,
      abortSession: async (id) => void aborted.push(id),
    });
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId!;
    cr.finish({ status: 'error', finalText: '', errorMessage: 'boom' });
    await tick();

    sig.retry(sessionId);
    await tick();
    const requestId = c.last('turn.reopen')!.payload.requestId;

    d.cancel('conn-1', requestId);
    expect(aborted).toEqual([sessionId]);
    cr.latest().onEnd({
      status: 'error',
      finalText: '',
      errorMessage: 'aborted',
      durationMs: 2,
    });
    const end = c.ofType('turn.end').at(-1)!.payload;
    expect(end.requestId).toBe(requestId);
    expect(end.status).toBe('cancelled');
    expect(end.errorMessage).toBeNull();
  });

  it('目录已被移出工作目录映射 -> 不接回(与执行前的映射收口同一道判定)', async () => {
    const cr = continuationRunner();
    const sig = signalSource();
    const c = collector();
    let config: HookConnectionConfig | null = CONFIG;
    const d = createHookDispatcher({
      getConnection: () => config,
      bindings: memoryBindings(),
      runner: cr.runner,
      subscribeUiContinuation: sig.subscribe,
      log: noopLog,
    });
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId!;
    cr.finish({ status: 'error', finalText: '', errorMessage: 'boom' });
    await tick();

    config = { ...CONFIG, workspaces: {} };
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);
  });

  it('别的 turn 先跑起来也不会被误认(clientId 对不上就不认领)', async () => {
    // 这条锁的是本 PR 最核心的保证。观察器是会话级的、分不清事件属于哪条用户消息,
    // 所以归属**不能**靠"首个事件"或 isBusy 快照去猜 —— 绕过 coordinator 的路径
    // (silent-stop 自动续跑)照样能直接 session.send, 任何快照都拦不住它。
    // 现在归属键是 clientId: 对不上就连观察器都不挂, 于是结构上不可能被误认。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.fire(sessionId);
    await tick();

    // 会话里先跑起来的是**另一条**消息(clientId 不同)。
    sig.dispatchTurn(sessionId, 'some-unrelated-client-id');
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);

    // 而且它同时作废了意图与记账: 与 enqueue 侧同一条规则 —— 这个任务被无关内容推进过,
    // 就不再把任何结果接回那条旧消息。哪怕目标那条随后真的 dispatch 也不接。
    // 取舍是明确的: 这里判错的代价是"渠道消息停在失败上"(本能力之前的状态), 反过来
    // 放行则是"把无关输出写进用户那条消息", 后者是真的错。
    sig.dispatchTurn(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);
  });

  it('会话正忙也不再是拒绝理由(归属由 clientId 保证, 不靠忙闲快照)', async () => {
    // 旧实现用 isBusy 拒绝, 那既拦不住绕过 coordinator 的 turn, 又会把"排队后才跑"
    // 的合法续跑误杀。远端慢启动尤其常见: 点重试时会话可能仍在收尾上一轮。
    const { cr, sig, c, sessionId } = await failOneTask();
    cr.busy.add(sessionId);
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('断连后能力快照即失效 -> 不再为这条连接白挂观察器', async () => {
    // serverFeatures 只在握手时权威。断连后不清, supportsReopen 会拿上一次的快照
    // 继续放行: 观察器照挂、记账照消耗, 而 sendFns 早已删掉 —— 帧根本发不出去,
    // 白挂一个要空转 2 分钟才退场的监听, 且这条消息线的续跑机会被无谓吃掉。
    const { cr, sig, d, sessionId } = await failOneTask();
    d.onDisconnected('conn-1');
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
  });

  it('已认领的续跑轮在其连接断开时被撤掉 -> 重连后不再用 stale id 发帧', async () => {
    // 断连是续跑回流的终局: server 此刻收口那条消息并解绑这一轮的 requestId。
    // 观察器若活到重连后, progress / turn.end 会带着已解绑的 id 发到新 socket
    // (dispatchId 在重连间稳定, 所以真发得出去), 更糟的是 error 收口还会把这个
    // stale id 登记成下一轮的 reopenOf。
    const { cr, sig, c, d, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    const reopened = c.last('turn.reopen')!.payload.requestId;
    expect(cr.cancels).toHaveLength(0);

    d.onDisconnected('conn-1');
    // 撤销即收口 -> 观察器被取消(cancels 记录了它)。
    expect(cr.cancels).toHaveLength(1);

    // 重连后即使那一轮还想发东西, 也不该再有帧带着 stale id 出去。
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    cr.latest().onProgress('迟到的进度');
    cr.latest().onEnd({ status: 'error', finalText: '', errorMessage: '又崩了', durationMs: 3 });
    await tick();
    expect(c.ofType('turn.progress').filter((m) => m.payload.requestId === reopened)).toHaveLength(
      0,
    );
    expect(c.ofType('turn.end').filter((m) => m.payload.requestId === reopened)).toHaveLength(0);

    // 也不该把这个已被 server 解绑的 id 记成下一轮的 reopenOf。
    const reopensBefore = c.ofType('turn.reopen').length;
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(reopensBefore);
  });

  it('中间跑过无关的桌面 turn -> 记账作废, 之后的重试不再改写渠道原消息', async () => {
    // 记账只按 sessionId 记, 而普通桌面 turn 不经本模块。没有这条作废, 用户在跑过
    // 别的 turn 之后点重试, 观察器会把那个无关 turn 的输出写进渠道那条旧消息。
    // isBusy 守卫挡不住它: 点重试时会话并不忙。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.intervene(sessionId);
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);
  });

  it('续跑本身的原文重发不会自我作废(信号先于发送事务)', async () => {
    // coordinator 是在 drain **之前**同步发重试信号的, 所以真正的续跑先认领(记账
    // 已消耗), 随后那条原文消息落到"无关介入"通道时只是 no-op。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);

    // 模拟零产出重试重发的原文走到发送事务。
    sig.intervene(sessionId);
    cr.latest().onProgress('干活中');
    await tick();
    expect(c.ofType('turn.progress')).toHaveLength(1);
  });

  it('还在等 dispatch 时来了无关消息 -> 意图作废, 之后那条 dispatch 也不再接上', async () => {
    // "重试哪一轮"与"渠道消息对应哪一轮"是两件事: 用户跑过无关 turn 之后点重试,
    // 重试的是那个无关 turn, 不该把它的输出写进渠道那条旧消息。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.fire(sessionId);
    await tick();

    sig.intervene(sessionId);
    await tick();
    // 意图已作废: 即使那条消息随后真的 dispatch 了, 也不该挂观察、不该发帧。
    sig.dispatchTurn(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);
  });

  it('意图死在落库之前 -> 记账留着, 用户再点一次仍然接得上', async () => {
    // 被意识钩挡掉 / 落库失败 / 排队被丢的那条消息, 既走不到 dispatching 也不会发
    // undispatched(它压根没跨过持久化边界)。记账若在记意图时就被转移走, 这类静默失败
    // 会把它吃掉, 之后谁也接不回来 —— 所以记账要留到 claim 帧真的发出才作废。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.fire(sessionId, 'client-blocked');
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);

    // 用户再点一次(是条新消息, 于是新 clientId)。
    sig.retry(sessionId, 'client-second');
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('失败登记之前就进队的无关消息 -> 它 dispatch 时作废记账', async () => {
    // 那条消息在 hook turn 还没收口时就 enqueue 了, 介入信号在"记账还不存在"时发过一次
    // 就不再发第二次。只靠 enqueue 侧作废会漏掉它, 于是它跑完之后用户点重试, 会把这个
    // 无关 turn 的输出写进渠道那条旧消息。dispatch 侧同样观测"会话被推进"即可关掉。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.dispatchTurn(sessionId, 'unrelated-client');
    await tick();

    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(0);
    expect(c.ofType('turn.reopen')).toHaveLength(0);
  });

  it('已认领的那一轮被别的 dispatch 顶掉 -> 就地收口, 不挂到硬超时', async () => {
    // coordinator 的派发边界(activeTurn 非空或 isTurnRunning)不放行任何并发 dispatch,
    // 插话走 steer 也不发这条信号 —— 所以"另一条用户轮居然 dispatch 了"等价于"我们这一轮
    // 已经不是活跃轮"。正常收口的话观察器早在终态事件上 settle 并出表了, 还在表里就说明它
    // 是被 Stop 之类抢在 vendor dispatch 与收口检查之间顶掉的, 而 coordinator 那条路径不发
    // undispatched。不就地收口, 渠道消息会停在"进行中"直到 1 小时硬超时。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    const reopened = c.ofType('turn.reopen')[0]?.payload.requestId;
    expect(reopened).toBeTruthy();

    sig.dispatchTurn(sessionId, 'unrelated-client');
    await tick();
    expect(cr.cancels).toHaveLength(1);

    // 撤销让 runner 以"已取消"收口, 那条 turn.end 必须真的发出去(连接还在)。
    cr.latest().onEnd({
      status: 'error',
      finalText: '',
      errorMessage: '被顶掉了',
      durationMs: 5,
    });
    await tick();
    const ends = c.ofType('turn.end').filter((m) => m.payload.requestId === reopened);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.payload.status).toBe('error');

    // 这条消息线已经交给别人了 -> 不再记待续跑, 之后的重试不该再改写它。
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('claim 帧发不出去 -> 撤观察、留记账, 且一帧都不带这个未认领的 requestId 出去', async () => {
    // WS 已进 CLOSING 但 onDisconnected 还没到时, send 返回 false。此时:
    //   - 不能"只是不认领": runner 那边按契约认为认领发生过, 不会再给第二次机会,
    //     观察器留着就要挂到 1 小时硬超时 —— 所以要撤;
    //   - 记账必须留着: 渠道那条消息此刻仍是原来的失败态, 没被改写过;
    //   - 一帧都不能带这个 requestId 出去: server 从没把消息挂到它上面。
    // 用户那一轮**照常跑**: 回流是增强, 不是关键路径(信号 fan-out 吞掉监听方异常,
    // 结构上就不可能让它 abort 掉 pre-vendor dispatch)。
    const { cr, sig, c, sessionId } = await failOneTask();
    c.setOnline(false);
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(0);
    expect(cr.cancels).toContain(0);

    // 记账还在: 连接恢复后再点一次重试就能接上。
    c.setOnline(true);
    sig.retry(sessionId, 'retry-client-2');
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('附件收集期间排在后面的桌面消息 dispatch -> 不算顶替, 成功结果照样如实收口', async () => {
    // 成功那一路要先异步收集出站附件, onEnd 因此晚于"停止观察"。这段时间里若还把这一轮
    // 算作"在观察", 排在后面的桌面消息一 dispatch 就会命中顶替判定 —— 而它其实已经跑完了。
    // runner 在 settle 的同步段就发 onSettling, dispatcher 据此摘账, 于是「表里还有这一轮」
    // 严格等价于「它仍在观察」, 顶替判定的前提才成立。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);
    const reopened = c.last('turn.reopen')!.payload.requestId;

    // 观察结束(附件还在收集中), 随后排在后面的那条桌面消息 dispatch。
    cr.watches[0]!.onSettling?.();
    sig.dispatchTurn(sessionId, 'queued-after-client');
    await tick();
    // 关键断言: 它没被当成"被顶掉"而撤销。少了 onSettling 这一步, 这里会记下一次撤销
    // (log 里也会留一条 superseded), 即对一轮**已经跑完**的续跑做无谓的撤销记账。
    expect(cr.cancels).toHaveLength(0);

    // 迟到的成功收口如实发出去 —— 不是 cancelled, 也没被撤掉。
    cr.watches[0]!.onEnd({
      status: 'ok',
      finalText: '续跑的结果',
      errorMessage: null,
      durationMs: 12,
    });
    await tick();
    const ends = c.ofType('turn.end').filter((m) => m.payload.requestId === reopened);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.payload.status).toBe('ok');
    expect(ends[0]!.payload.finalText).toBe('续跑的结果');
  });

  it('turn 跑到一半断连 -> 失败收口仍记待续跑(重连后点重试接得上)', async () => {
    // 失败的 turn.end 走 sendOrBuffer, 重连后补发, 渠道里确实会显示失败。但收口那一刻
    // 连接已断、能力快照已被 onDisconnected 清掉, 若在那时才查能力就不会记待续跑 ——
    // 用户点重试便接不回来。能力要在**接活时**取快照。
    const cr = continuationRunner();
    const sig = signalSource();
    const c = collector();
    const { d } = makeDispatcher({
      runner: cr.runner,
      subscribeUiContinuation: sig.subscribe,
      subscribeUiSessionIntervention: sig.subscribeIntervention,
      subscribeUiTurnDispatching: sig.subscribeDispatching,
      subscribeUiTurnUndispatched: sig.subscribeUndispatched,
    });
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId!;

    // turn 跑到一半 socket 断了, 然后它以失败收口(turn.end 进缓存)。
    d.onDisconnected('conn-1');
    cr.finish({ status: 'error', finalText: '', errorMessage: 'boom' });
    await tick();

    // 重连(dispatchId 稳定, 同一个 connectionId): 缓存的失败被补发。
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    await tick();
    expect(c.last('turn.end')!.payload.status).toBe('error');

    // 现在点重试 —— 记账在, 能接上。
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);
    expect(c.ofType('turn.reopen')).toHaveLength(1);
  });

  it('迟到的收口只删自己那一轮, 不把后来注册的那一轮从表里抹掉', async () => {
    // 成功收口要先异步收集出站附件, 所以 onEnd 可能落在"本轮已被接管、用户又续了一次、
    // 新一轮已注册"之后。按 sessionId 无条件删就会把**新**那一轮抹掉 —— 它的观察器于是
    // 躲过断连与后续接管的撤销, 拿已被 server 解绑的 requestId 继续发帧。
    const { cr, sig, c, d, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(1);

    // 新 hook 任务接管(第一轮的 onEnd 还压在附件收集里没发出来)。
    cr.sessions[sessionId] = { workingDir: WS_DIR, usable: true };
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-take-over', prompt: '新任务' }), c.send);
    await tick();
    expect(cr.cancels).toContain(0);
    cr.finish({ status: 'error', finalText: '', errorMessage: '又失败了' });
    await tick();

    // 用户又续了一次 -> 第二轮注册。
    sig.retry(sessionId, 'retry-client-2');
    await tick();
    expect(cr.watches).toHaveLength(2);

    // 第一轮那条迟到的成功收口现在才到。
    cr.watches[0]!.onEnd({
      status: 'ok',
      finalText: '早先那轮的结果',
      errorMessage: null,
      durationMs: 9,
    });
    await tick();

    // 第二轮必须还在表里 —— 断连时它得能被撤掉。
    d.onDisconnected('conn-1');
    expect(cr.cancels).toContain(1);
  });

  it('新 hook 任务接管时清掉在等的意图(迟到的重试不能改写已过期的消息)', async () => {
    // 意图记下后还没 dispatch(远端冷启动 / 凭证切换都在 dispatch 之前), 这时同一会话来了
    // 新 hook 任务。它接管了消息线, 那条意图自带的 entry 已经过期 —— 不清掉的话, 新任务失败
    // 登记自己的记账之后, 那条迟到的重试会匹配上陈旧意图, 拿已被 server 解绑的旧 reopenOf
    // 去认领, 还顺带把新记账删掉。
    const { cr, sig, c, d, sessionId } = await failOneTask();
    sig.fire(sessionId);
    await tick();

    // 同一 externalKey 的新 hook 任务跑起来, 并同样以失败收口 -> 记账换成它的 requestId。
    // (让 inspect 看见这个 session, 第二条派发才会落到同一个任务上。)
    cr.sessions[sessionId] = { workingDir: WS_DIR, usable: true };
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-take-over', prompt: '新任务' }), c.send);
    await tick();
    cr.finish({ status: 'error', finalText: '', errorMessage: '又失败了' });
    await tick();

    // 那条迟到的重试终于 dispatch —— 不该认领任何东西。
    const reopensBefore = c.ofType('turn.reopen').length;
    sig.dispatchTurn(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(reopensBefore);
    expect(cr.watches).toHaveLength(0);
  });

  it('已认领的续跑轮不因无关消息被撤(它已在往渠道写, 后来的消息只会排队)', async () => {
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);

    sig.intervene(sessionId);
    expect(cr.cancels).toHaveLength(0);
    cr.latest().onProgress('续跑进度');
    await tick();
    expect(c.ofType('turn.progress')).toHaveLength(1);
  });

  it('认领后才发现没能 dispatch -> 撤掉观察并按失败收口(不挂到硬超时)', async () => {
    // dispatching 信号发在 vendor dispatch **之前**, 之后仍有会失败的环节(Stop 抢在
    // 持久化之后、pre-vendor hook 抛错)。那一轮压根没跑起来, 但渠道消息已被改成
    // "进行中" —— 必须撤掉观察让它按失败收口。
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);
    expect(cr.cancels).toHaveLength(0);

    const reopened = c.last('turn.reopen')!.payload.requestId;
    sig.undispatchTurn(sessionId);
    await tick();
    expect(cr.cancels).toHaveLength(1);

    // 连接还在 -> 撤销后的收口帧**必须发得出去**, 否则渠道那条消息停在假的"进行中"
    // 直到 1 小时硬超时。(只有连接已断才静默, 那时 server 已做过孤儿收口。)
    cr.latest().onEnd({
      status: 'error',
      finalText: '',
      errorMessage: 'hook continuation cancelled',
      durationMs: 1,
    });
    await tick();
    expect(c.ofType('turn.end').filter((m) => m.payload.requestId === reopened)).toHaveLength(1);

    // 且记账还回去了: 这一轮压根没跑起来, 用户马上会再点一次重试。
    sig.retry(sessionId);
    await tick();
    expect(cr.watches).toHaveLength(2);
  });

  it('undispatched 的 clientId 对不上时不动已认领的那一轮', async () => {
    const { cr, sig, c, sessionId } = await failOneTask();
    sig.retry(sessionId);
    await tick();
    expect(c.ofType('turn.reopen')).toHaveLength(1);

    sig.undispatchTurn(sessionId, 'some-other-client-id');
    await tick();
    expect(cr.cancels).toHaveLength(0);
  });

  it('dispose() 退订信号源(不只是清记账)', async () => {
    // 直接断言订阅数, 不看下游行为: dispose 同时清了 pendingReopens, 只看
    // "有没有起观察" 的话, 即使退订漏了也照样为 0 —— 那样这条锁就是假的。
    const cr = continuationRunner();
    const sig = signalSource();
    const c = collector();
    const { d } = makeDispatcher({ runner: cr.runner, subscribeUiContinuation: sig.subscribe });
    d.onConnected('conn-1', c.send, REOPEN_FEATURES);
    expect(sig.listenerCount()).toBe(1);
    d.dispose();
    expect(sig.listenerCount()).toBe(0);
  });
});
