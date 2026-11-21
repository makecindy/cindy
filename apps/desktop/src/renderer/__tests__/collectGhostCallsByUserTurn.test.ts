/**
 * collectGhostCallsByUserTurn.test.ts
 * ---------------------------------------------------------------------------
 * 「提及 → 兑现」关联(意识软提示卡升级方案 2):从会话历史推导"每条 user
 * 消息触发的那一轮里,AI 真调用了哪些意识"。判据全取自持久数据(user 消息
 * + ghost_call tool_use),渲染期现算、不落状态,故重启幂等——本测试锁死
 * 归属正确、turn 边界、非 ghost_call 不计、steer/synthetic 不夺边界。
 */

import { describe, expect, it } from 'vitest';
import { buildRenderItems, collectGhostCallsByUserTurn, ghostCallMapsEqual } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';
import { EMPTY_SESSION_STATE, handleStreamEvent, makerChatStore } from '@/lib/makerChatStore';
import { projectRemoteUsers } from '@/lib/remoteUserHandoff';
import { createMessageMetadataProjection } from '../components/chat/streamingMessageProjection';

const user = (clientId: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ clientId, role: 'user', content: clientId, isStreaming: false, ...extra }) as ChatMessage;

const ghostCall = (clientId: string, ghostId: string, toolName = 'mcp__cindy__ghost_call'): ChatMessage =>
  ({
    clientId,
    role: 'assistant',
    content: '',
    isStreaming: false,
    toolName,
    toolInput: { ghost_id: ghostId, tool: 'gen_image' },
  }) as ChatMessage;

// Regression: collapsed history hands user rows off before their tool details.
// Exercise the real display projection and persisted/live metadata entry points;
// an ordered user/call/result mock cannot reproduce the inherited annotation.
describe('plugin call ownership across history handoff', () => {
  const call = (owner: string): ChatMessage => ({
    ...ghostCall('old-call', 'art'), role: 'tool_use', toolUseId: 'old-call', replyToClientId: owner,
  });
  const result: ChatMessage = { clientId: 'result', role: 'tool_result', toolUseId: 'old-call', content: '' };

  it.each([false, true])('does not give a reordered old call to a new user (returned=%s)', (returned) => {
    const raw = [user('old'), call('old'), ...(returned ? [result] : []), user('new')];
    const displayed = projectRemoteUsers(raw, new Set(['old', 'new']));
    expect(displayed.map(row => row.clientId)).toEqual(['old', 'new', 'old-call', ...(returned ? ['result'] : [])]);
    const summary = collectGhostCallsByUserTurn(displayed, true);
    expect(summary.has('new')).toBe(false);
    expect(summary.get('old')?.running).toBe(false);
    expect(summary.get('old')?.pendingGhostIds.size).toBe(returned ? 0 : 1);
  });

  it('does not guess an owner when the explicit owner is outside the loaded window', () => {
    expect(collectGhostCallsByUserTurn([user('new'), call('outside'), result], true).size).toBe(0);
  });

  // The coordinator stamps accepted steering IDs onto later tool/terminal
  // events. They belong to the same bubble as legacy unqualified steer calls.
  it.each(['assistant', 'error'] as const)('maps explicit steering ownership and its %s terminal to the original turn', (role) => {
    const oldTerminal: ChatMessage = {
      clientId: 'old-terminal', role, content: 'done', replyToClientId: 'old-steer', turnCompleted: true,
    };
    const fresh = { ...call('new-steer'), clientId: 'new-call', toolUseId: 'new-call' };
    const messages = [user('old'), user('old-steer', { delivery: 'steer' }), user('new'),
      user('new-steer', { delivery: 'steer' }), call('old-steer'), result, fresh, oldTerminal];
    for (const rows of [messages, JSON.parse(JSON.stringify(messages)) as ChatMessage[]]) {
      const summary = collectGhostCallsByUserTurn(rows, true);
      expect(summary.get('old')?.pendingGhostIds.size).toBe(0);
      expect(summary.get('old')?.running).toBe(false);
      expect(summary.get('new')?.running).toBe(true);
      expect(summary.has('old-steer')).toBe(false);
      expect(summary.has('new-steer')).toBe(false);
      const sealed = [...rows, { ...oldTerminal, clientId: 'new-terminal', replyToClientId: 'new-steer' }];
      expect(collectGhostCallsByUserTurn(sealed, true).get('new')?.running).toBe(false);
    }
  });

  it('does not map an orphaned steer or one after a synthetic boundary to a previous human', () => {
    for (const prefix of [[], [user('old'), user('trigger', { isSyntheticTrigger: true })]]) {
      expect(collectGhostCallsByUserTurn([...prefix, user('steer', { delivery: 'steer' }), call('steer')], true).size).toBe(0);
    }
  });

  it.each(['assistant', 'error'] as const)('an old %s terminal cannot seal a newer turn', (role) => {
    const terminal: ChatMessage = {
      clientId: 'old-terminal', role, content: 'done', replyToClientId: 'old', turnCompleted: true,
    };
    const fresh = { ...call('new'), clientId: 'new-call', toolUseId: 'new-call' };
    for (const tail of [[terminal, fresh], [fresh, terminal]]) {
      const summary = collectGhostCallsByUserTurn([user('old'), user('new'), ...tail], true);
      expect(summary.get('new')?.running).toBe(true);
    }
  });

  it('keeps the current owner terminal effective', () => {
    const terminal: ChatMessage = {
      clientId: 'terminal', role: 'assistant', content: 'done', replyToClientId: 'new', turnCompleted: true,
    };
    expect(collectGhostCallsByUserTurn([user('new'), call('new'), terminal], true).get('new')?.running).toBe(false);
  });

  it('preserves the explicit owner on live tool events and on history reload', () => {
    const input = { ghost_id: 'art', tool: 'gen_image' };
    const live = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 'ownership-test', type: 'tool_use', persistId: 'old-call',
      data: { toolUseId: 'old-call', toolName: 'mcp__cindy__ghost_call', input },
      agentMeta: { replyToClientId: 'old' },
    });
    expect(live.messages.at(-1)?.replyToClientId).toBe('old');
    const restored = makerChatStore.__mapServerMessagesForTest([
      { role: 'tool_use', content: { toolUseId: 'old-call', toolName: 'mcp__cindy__ghost_call', input } },
      { role: 'assistant', content: 'done' },
      { role: 'error', content: 'failed' },
      { role: 'error', content: { message: 'failed' } },
    ].map((row, index) => ({
      ...row, id: `row-${index}`, clientId: `restored-${index}`, sessionId: 'ownership-test',
      toolUseId: null, createdAt: `2026-11-20T00:00:0${index}.000Z`,
      agentMeta: { replyToClientId: 'old', turnCompleted: true },
    })) as Parameters<typeof makerChatStore.__mapServerMessagesForTest>[0]);
    expect(restored).toHaveLength(4);
    expect(restored.map(row => row.replyToClientId)).toEqual(['old', 'old', 'old', 'old']);
  });

  it('keeps 10,000 historical turns stable across 50 live text updates', () => {
    const history = Array.from({ length: 10_000 }, (_, index): ChatMessage[] => {
      const owner = `user-${index}`;
      const id = `call-${index}`;
      return [user(owner), { ...call(owner), clientId: id, toolUseId: id },
        { ...result, clientId: `result-${index}`, toolUseId: id },
        { clientId: `final-${index}`, role: 'assistant', content: 'done', replyToClientId: owner, turnCompleted: true }];
    }).flat();
    const rows: ChatMessage[] = [...history, user('new'),
      { clientId: 'stream', role: 'assistant', content: 'Working', isStreaming: true, replyToClientId: 'new' }];
    const project = createMessageMetadataProjection();
    const metadata = project(rows);
    const summary = collectGhostCallsByUserTurn(metadata, true);
    expect(summary.size).toBe(10_000);
    expect(summary.has('new')).toBe(false);
    expect(summary.get('user-0')?.pendingGhostIds.size).toBe(0);
    expect(summary.get('user-9999')?.running).toBe(false);
    for (let index = 0; index < 50; index++) {
      const next = [...rows.slice(0, -1), { ...rows.at(-1)!, content: `Working ${index}` }];
      // MessageStream's useMemo retains both the collector result and context
      // when this dependency is unchanged, despite the live body changing.
      expect(project(next)).toBe(metadata);
    }
    const reloaded = collectGhostCallsByUserTurn(JSON.parse(JSON.stringify(rows)) as ChatMessage[], true);
    expect(ghostCallMapsEqual(summary, reloaded)).toBe(true);
  });
});

/**
 * 测试价值：生产 collector 必须让气泡在结果到达后停止，而非等待整轮结束（#9235）。
 * 原覆盖只检查插件归属，未检查结果时序；最小输入为 user/call/result + streaming=true。
 * tier: unit，复用同一生产入口覆盖并发、后续消息与中断，不启动真实插件。
 */
describe('plugin annotation follows actual calls, not the assistant turn', () => {
  const call = (id: string, ghost = 'art') => ({ ...ghostCall(id, ghost), toolUseId: id });
  const result = (id: string): ChatMessage => ({ clientId: `result-${id}`, role: 'tool_result', toolUseId: id, content: '' });

  it('stops as soon as an empty result arrives, including non-adjacent results', () => {
    const state = collectGhostCallsByUserTurn([user('u1'), call('c1'), user('s1', { delivery: 'steer' }), result('c1')], true).get('u1');
    expect(state?.running).toBe(false);
    expect(state?.pendingGhostIds.size).toBe(0);
  });

  it('keeps running until every concurrent call returns, including repeated calls to one plugin', () => {
    const messages = [user('u1'), call('c1'), call('c2'), call('c3', 'poster')];
    const partial = collectGhostCallsByUserTurn([...messages, result('c1'), result('c3')], true).get('u1');
    expect(partial?.running).toBe(true);
    expect([...(partial?.pendingGhostIds ?? [])]).toEqual(['art']);
    expect(collectGhostCallsByUserTurn([...messages, result('c1'), result('c3'), result('c2')], true).get('u1')?.running).toBe(false);
  });

  // A primary-only coalesced summary and A's out-of-order individual result
  // have the same persisted shape. Unlike a generic work log row, a completion
  // badge must not guess that B returned merely because A's result is adjacent.
  it.each(['poster', 'art'])('does not guess that a second %s call completed from another ID', (secondGhost) => {
    const calls = [call('c1'), call('c2', secondGhost)].map(message => ({ ...message, role: 'tool_use' as const }));
    const pending = [user('u1'), ...calls];
    expect(collectGhostCallsByUserTurn(pending, true).get('u1')?.running).toBe(true);
    const returned = [...pending, result('c1')];
    const settled = buildRenderItems(returned).items.flatMap(item =>
      item.type === 'tool_segment' ? [...item.settledIds] : []);
    expect(settled).toEqual(['c1', 'c2']);
    for (const streaming of [true, false]) {
      const state = collectGhostCallsByUserTurn(JSON.parse(JSON.stringify(returned)) as ChatMessage[], streaming).get('u1');
      expect(state?.running).toBe(streaming);
      expect([...(state?.pendingGhostIds ?? [])]).toEqual([secondGhost]);
    }
    const completed = collectGhostCallsByUserTurn([...returned, result('c2')], true).get('u1');
    expect(completed?.running).toBe(false);
    expect(completed?.pendingGhostIds.size).toBe(0);
    expect(collectGhostCallsByUserTurn([...returned, user('u2')], true).has('u2')).toBe(false);
  });

  it('does not carry old calls or their spinner into the next ordinary message', () => {
    const states = collectGhostCallsByUserTurn([user('u1'), call('c1'), user('u2')], true);
    expect(states.has('u2')).toBe(false);
    expect(states.get('u1')?.running).toBe(false);
  });

  it('does not attribute calls after an autonomous trigger or a sealed turn to the old user', () => {
    for (const boundary of [user('trigger', { isSyntheticTrigger: true }), { clientId: 'final', role: 'assistant', content: 'done', turnCompleted: true } as ChatMessage]) {
      expect(collectGhostCallsByUserTurn([user('u1'), boundary, call('c1')], true).size).toBe(0);
    }
  });

  it('stops on interruption but retains the missing result instead of marking it completed', () => {
    const state = collectGhostCallsByUserTurn([user('u1'), call('c1')], false).get('u1');
    expect(state?.running).toBe(false);
    expect([...(state?.pendingGhostIds ?? [])]).toEqual(['art']);
  });
});

describe('collectGhostCallsByUserTurn', () => {
  it('does not merge root and organization calls with the same ghost id', () => {
    const root = { ...ghostCall('t1', 'helper'), toolInput: { ghost_id: 'helper', namespace: null, tool: 'run' } };
    const organization = { ...ghostCall('t2', 'helper'), toolInput: { ghost_id: 'helper', namespace: 'acme', tool: 'run' } };
    const map = collectGhostCallsByUserTurn([user('u1'), root, organization]);
    expect([...(map.get('u1')?.ghostIds ?? [])].sort()).toEqual(['_ns__acme__helper', '_root__helper']);
  });

  it('keeps legacy unqualified calls and ignores malformed namespace inputs', () => {
    const legacy = ghostCall('legacy', 'helper');
    const malformed = { ...ghostCall('bad', 'helper'), toolInput: { ghost_id: 'helper', namespace: 'bad namespace', tool: 'run' } };
    expect([...(collectGhostCallsByUserTurn([user('u1'), legacy]).get('u1')?.ghostIds ?? [])]).toEqual(['helper']);
    expect(collectGhostCallsByUserTurn([user('u1'), malformed]).has('u1')).toBe(false);
  });
  it('attributes a valid encoded instance id without an extra namespace', () => {
    const encoded = ghostCall('org', '_ns__acme__helper');
    expect([...(collectGhostCallsByUserTurn([user('u1'), encoded]).get('u1')?.ghostIds ?? [])])
      .toEqual(['_ns__acme__helper']);
    const invalid = { ...encoded, toolInput: { ghost_id: '_ns__acme__helper', namespace: 'globex', tool: 'run' } };
    expect(collectGhostCallsByUserTurn([user('u1'), invalid]).has('u1')).toBe(false);
  });
  it('把 ghost_call 归到其所在 turn 的 user 消息名下', () => {
    const map = collectGhostCallsByUserTurn([user('u1'), ghostCall('t1', 'art')]);
    expect([...(map.get('u1')?.ghostIds ?? [])]).toEqual(['art']);
  });

  it('旧 server 名(cindy_ghosts)的历史消息同样计入(2026-07-12 更名兼容)', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      ghostCall('t1', 'art', 'mcp__cindy_ghosts__ghost_call'),
    ]);
    expect([...(map.get('u1')?.ghostIds ?? [])]).toEqual(['art']);
  });

  it('turn 边界:后一轮的调用不算到前一条 user 头上', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      ghostCall('t1', 'art'),
      user('u2'),
      ghostCall('t2', 'poster'),
    ]);
    expect([...(map.get('u1')?.ghostIds ?? [])]).toEqual(['art']);
    expect([...(map.get('u2')?.ghostIds ?? [])]).toEqual(['poster']);
  });

  it('一轮内多个意识去重收集;只提及未调用的 user 不进 map', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      ghostCall('t1', 'art'),
      ghostCall('t2', 'art'),
      ghostCall('t3', 'poster'),
      user('u2'), // 这一轮没有 ghost_call
    ]);
    expect([...(map.get('u1')?.ghostIds ?? [])].sort()).toEqual(['art', 'poster']);
    expect(map.has('u2')).toBe(false);
  });

  it('非 ghost_call 工具不计入', () => {
    const other = {
      clientId: 't1',
      role: 'assistant',
      content: '',
      isStreaming: false,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    } as ChatMessage;
    const map = collectGhostCallsByUserTurn([user('u1'), other]);
    expect(map.has('u1')).toBe(false);
  });

  it('steer 不夺 turn 边界(合成触发隔离由上方回归覆盖)', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      user('s1', { delivery: 'steer' }),
      ghostCall('t1', 'art'),
    ]);
    expect([...(map.get('u1')?.ghostIds ?? [])]).toEqual(['art']);
    expect(map.has('s1')).toBe(false);
    expect(map.has('y1')).toBe(false);
  });

  it('ghost_id 缺失 / 非字符串 → 跳过', () => {
    const bad = {
      clientId: 't1',
      role: 'assistant',
      content: '',
      isStreaming: false,
      toolName: 'mcp__cindy_ghosts__ghost_call',
      toolInput: { tool: 'gen_image' },
    } as ChatMessage;
    const map = collectGhostCallsByUserTurn([user('u1'), bad]);
    expect(map.has('u1')).toBe(false);
  });
});

describe('ghostCallMapsEqual(Provider value 引用缓存的结构等价判断)', () => {
  const mk = (entries: Array<[string, string[]]>) =>
    new Map(entries.map(([k, v]) => [k, { ghostIds: new Set(v), pendingGhostIds: new Set<string>(), running: false }]));

  it('内容相同但引用不同 → 相等(流式重算场景)', () => {
    expect(ghostCallMapsEqual(mk([['u1', ['art']]]), mk([['u1', ['art']]]))).toBe(true);
    expect(ghostCallMapsEqual(mk([]), mk([]))).toBe(true);
  });

  it('key 集合 / set 内容任一不同 → 不等', () => {
    expect(ghostCallMapsEqual(mk([['u1', ['art']]]), mk([['u2', ['art']]]))).toBe(false);
    expect(ghostCallMapsEqual(mk([['u1', ['art']]]), mk([['u1', ['poster']]]))).toBe(false);
    expect(ghostCallMapsEqual(mk([['u1', ['art']]]), mk([['u1', ['art', 'poster']]]))).toBe(false);
    expect(ghostCallMapsEqual(mk([['u1', ['art']]]), mk([]))).toBe(false);
  });

  it('同引用短路为真', () => {
    const m = mk([['u1', ['art']]]);
    expect(ghostCallMapsEqual(m, m)).toBe(true);
  });

  it('invalidates the UI context when only result settlement or activity changes', () => {
    const completed = mk([['u1', ['art']]]);
    const pending = new Map([['u1', { ghostIds: new Set(['art']), pendingGhostIds: new Set(['art']), running: false }]]);
    expect(ghostCallMapsEqual(completed, pending)).toBe(false);
    const running = new Map([['u1', { ...pending.get('u1')!, running: true }]]);
    expect(ghostCallMapsEqual(pending, running)).toBe(false);
  });
});
