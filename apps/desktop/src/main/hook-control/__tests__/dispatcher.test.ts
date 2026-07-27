/**
 * dispatcher 单测: 注入假 runner / bindings / store, 覆盖协议语义的全部分支 ——
 * 幂等回放、别名白名单、binding 复用(同 key 同 session)、接管(sessionId 路径
 * 及其两种拒绝)、排队 FIFO、turn.end 回推与离线缓存补发。
 */

import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { HookMessage, TaskDispatchPayload } from '@cindy/slack-hook-protocol';

import {
  buildHookSessionTitle,
  createHookDispatcher,
  isPathWithin,
  isSamePath,
  normalizeTaskSource,
  type HookDispatcherDeps,
  type HookRunOutcome,
  type HookRunRequest,
  type HookSessionRunner,
} from '../dispatcher';
import type { HookBindingEntry, HookBindingStore } from '../bindings';
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

/** 内存 binding(含工作目录快照与授权来源, 与文件实现同语义)。 */
function memoryBindings(): HookBindingStore {
  const map = new Map<string, HookBindingEntry>();
  const k = (c: string, e: string): string => `${c}|${e}`;
  return {
    get: (c, e) => map.get(k(c, e))?.sessionId ?? null,
    getEntry: (c, e) => {
      const row = map.get(k(c, e));
      return row ? { ...row } : null;
    },
    set: (c, e, s, workingDir, authority) =>
      void map.set(k(c, e), {
        sessionId: s,
        workingDir: workingDir ?? null,
        authority: authority ?? null,
      }),
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

describe('isSamePath', () => {
  it('同一目录的不同写法算相同, 子目录不算', () => {
    expect(isSamePath(WS_DIR, WS_DIR)).toBe(true);
    expect(isSamePath(WS_DIR, path.join(WS_DIR, 'sub', '..'))).toBe(true);
    expect(isSamePath(WS_DIR, `${WS_DIR}${path.sep}`)).toBe(true);
    expect(isSamePath(WS_DIR, path.join(WS_DIR, 'sub'))).toBe(false);
    expect(isSamePath(WS_DIR, path.resolve('/repos/other'))).toBe(false);
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

  it('会话被移出工作目录映射: 目录变过 -> 跟随复用并说明, 不重开新会话', async () => {
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
    expect(c.last('task.ack')!.payload).toMatchObject({ result: 'accepted', sessionId: first });
    expect(fr.calls[1]).toMatchObject({ isNew: false, sessionId: first, workingDir: MOVED_DIR });
    // 快照跟随移动, 并记下"这份授权来自本地移动"
    expect(bindings.getEntry('conn-1', 'team-slack:C1:1.1')).toEqual({
      sessionId: first,
      workingDir: MOVED_DIR,
      authority: 'local-move',
    });

    fr.finish({ finalText: '在新目录里跑完了' });
    await tick();
    const finalText = c.last('turn.end')!.payload.finalText;
    expect(finalText).toContain('已被移动到新的工作目录');
    expect(finalText).toContain('在新目录里跑完了');
  });

  it('移动后的后续消息持续复用同一 session, 且不再重复提示(跟随不能只生效一次)', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    const MOVED_DIR = path.resolve('/repos/another-project');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: WS_DIR, usable: true };
    fr.finish();
    await tick();

    // 移动后连发两条: 第二条时快照已等于新目录, 只有持久化的授权来源能保住复用
    sessions[first] = { workingDir: MOVED_DIR, usable: true };
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    fr.finish({ finalText: '第一次' });
    await tick();

    d.handleDispatch('conn-1', dispatch({ requestId: 'req-3' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload).toMatchObject({ result: 'accepted', sessionId: first });
    expect(fr.calls[2]).toMatchObject({ isNew: false, sessionId: first, workingDir: MOVED_DIR });

    fr.finish({ finalText: '第二次' });
    await tick();
    // 说明只在"这次刚发现被移动"时出现一次
    expect(c.last('turn.end')!.payload.finalText).toBe('第二次');
  });

  it('对话移回工作目录映射内: 授权来源复位, 此后映射被改仍按撤权重建', async () => {
    const bindings = memoryBindings();
    const sessions: Record<string, { workingDir: string; usable: boolean }> = {};
    const fr = fakeRunner({ sessions });
    const config: HookConnectionConfig = { ...CONFIG, workspaces: { xdmaker: WS_DIR } };
    const { d } = makeDispatcher({ runner: fr.runner, bindings, config });
    const c = collector();
    const MOVED_DIR = path.resolve('/repos/another-project');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    const first = c.last('task.ack')!.payload.sessionId!;
    sessions[first] = { workingDir: MOVED_DIR, usable: true };
    fr.finish();
    await tick();

    // 移出去一次(拿到 local-move 授权), 再移回映射内
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-2' }), c.send);
    await tick();
    fr.finish();
    await tick();
    sessions[first] = { workingDir: WS_DIR, usable: true };
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-3' }), c.send);
    await tick();
    expect(bindings.getEntry('conn-1', 'team-slack:C1:1.1')).toEqual({
      sessionId: first,
      workingDir: WS_DIR,
      authority: 'workspace',
    });
    fr.finish();
    await tick();

    // 授权已复位: 映射改指别处时按撤权重建, 不再吃老的 local-move
    config.workspaces = { xdmaker: path.resolve('/repos/elsewhere') };
    d.handleDispatch('conn-1', dispatch({ requestId: 'req-4' }), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.sessionId).not.toBe(first);
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
    expect(finalText).toContain('原对话已不在可用的工作目录里');
    expect(finalText).toContain('新会话的回答');
  });

  it('老绑定没有目录快照时按保守侧处理: 越界即重建', async () => {
    const bindings = memoryBindings();
    const OUTSIDE = path.resolve('/repos/another-project');
    const fr = fakeRunner({
      sessions: { 'legacy-session': { workingDir: OUTSIDE, usable: true } },
    });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    // v1 形态: 只有 sessionId, 无从判断目录是被用户移动还是映射被改
    bindings.set('conn-1', 'team-slack:C1:1.1', 'legacy-session');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();

    const sessionId = c.last('task.ack')!.payload.sessionId!;
    expect(sessionId).not.toBe('legacy-session');
    expect(fr.calls[0]).toMatchObject({ isNew: true, workingDir: WS_DIR });
    expect(bindings.getEntry('conn-1', 'team-slack:C1:1.1')).toEqual({
      sessionId,
      workingDir: WS_DIR,
      authority: 'workspace',
    });
    fr.finish();
  });

  it('正常复用顺手回填目录快照(存量绑定升级路径)', async () => {
    const bindings = memoryBindings();
    const fr = fakeRunner({ sessions: { 'legacy-session': { workingDir: WS_DIR, usable: true } } });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    bindings.set('conn-1', 'team-slack:C1:1.1', 'legacy-session');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();

    expect(c.last('task.ack')!.payload.sessionId).toBe('legacy-session');
    expect(bindings.getEntry('conn-1', 'team-slack:C1:1.1')).toEqual({
      sessionId: 'legacy-session',
      workingDir: WS_DIR,
      authority: 'workspace',
    });
    fr.finish({ finalText: '继续' });
    await tick();
    // 正常复用不打扰用户
    expect(c.last('turn.end')!.payload.finalText).toBe('继续');
  });

  it('绑定的会话已归档/删除 -> 重建并说明是原对话没了', async () => {
    const bindings = memoryBindings();
    const fr = fakeRunner({ sessions: { 'gone-session': { workingDir: WS_DIR, usable: false } } });
    const { d } = makeDispatcher({ runner: fr.runner, bindings });
    const c = collector();
    bindings.set('conn-1', 'team-slack:C1:1.1', 'gone-session', WS_DIR, 'workspace');

    d.handleDispatch('conn-1', dispatch(), c.send);
    await tick();
    expect(c.last('task.ack')!.payload.sessionId).not.toBe('gone-session');

    fr.finish({ finalText: '新的回答' });
    await tick();
    expect(c.last('turn.end')!.payload.finalText).toContain('原对话已被归档或删除');
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
    d.handleDispatch(
      'conn-1',
      dispatch({ requestId: 'r1', externalKey: 'slack:dm:U1:g1' }),
      c.send,
    );
    await tick();
    const sessionId = c.last('task.ack')!.payload.sessionId as string;
    fr.finish();
    await tick();

    d.handleSessionArchive('conn-1', 'slack:dm:U1:g1');
    await tick();
    expect(archived).toEqual([sessionId]);
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
    // 有绑定但行已不存在: 调用发生、异常被吞、绑定仍被清理
    d.handleSessionArchive('conn-1', 'slack:dm:U1:g2');
    await tick();
    expect(archiveCalls).toEqual(['sess-gone']);
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
