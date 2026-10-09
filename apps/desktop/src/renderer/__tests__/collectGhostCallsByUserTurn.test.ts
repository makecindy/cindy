/**
 * collectGhostCallsByUserTurn.test.ts
 * ---------------------------------------------------------------------------
 * 「提及 → 兑现」关联(意识软提示卡升级方案 2):从会话历史推导"每条 user
 * 消息触发的那一轮里,AI 真调用了哪些意识"。判据全取自持久数据(user 消息
 * + ghost_call tool_use),渲染期现算、不落状态,故重启幂等——本测试锁死
 * 归属正确、turn 边界、非 ghost_call 不计、steer/synthetic 不夺边界。
 */

import { describe, expect, it } from 'vitest';
import { collectGhostCallsByUserTurn, ghostCallMapsEqual } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

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

describe('collectGhostCallsByUserTurn', () => {
  it('does not merge root and organization calls with the same ghost id', () => {
    const root = { ...ghostCall('t1', 'helper'), toolInput: { ghost_id: 'helper', namespace: null, tool: 'run' } };
    const organization = { ...ghostCall('t2', 'helper'), toolInput: { ghost_id: 'helper', namespace: 'acme', tool: 'run' } };
    const map = collectGhostCallsByUserTurn([user('u1'), root, organization]);
    expect([...(map.get('u1') ?? [])].sort()).toEqual(['_ns__acme__helper', 'helper']);
  });

  it('keeps legacy unqualified calls and ignores malformed namespace inputs', () => {
    const legacy = ghostCall('legacy', 'helper');
    const malformed = { ...ghostCall('bad', 'helper'), toolInput: { ghost_id: 'helper', namespace: 'bad namespace', tool: 'run' } };
    expect([...(collectGhostCallsByUserTurn([user('u1'), legacy]).get('u1') ?? [])]).toEqual(['helper']);
    expect(collectGhostCallsByUserTurn([user('u1'), malformed]).has('u1')).toBe(false);
  });
  it('attributes a valid encoded instance id without an extra namespace', () => {
    const encoded = ghostCall('org', '_ns__acme__helper');
    expect([...(collectGhostCallsByUserTurn([user('u1'), encoded]).get('u1') ?? [])])
      .toEqual(['_ns__acme__helper']);
    const invalid = { ...encoded, toolInput: { ghost_id: '_ns__acme__helper', namespace: 'globex', tool: 'run' } };
    expect(collectGhostCallsByUserTurn([user('u1'), invalid]).has('u1')).toBe(false);
  });
  it('把 ghost_call 归到其所在 turn 的 user 消息名下', () => {
    const map = collectGhostCallsByUserTurn([user('u1'), ghostCall('t1', 'art')]);
    expect([...(map.get('u1') ?? [])]).toEqual(['art']);
  });

  it('旧 server 名(cindy_ghosts)的历史消息同样计入(2026-07-12 更名兼容)', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      ghostCall('t1', 'art', 'mcp__cindy_ghosts__ghost_call'),
    ]);
    expect([...(map.get('u1') ?? [])]).toEqual(['art']);
  });

  it('turn 边界:后一轮的调用不算到前一条 user 头上', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      ghostCall('t1', 'art'),
      user('u2'),
      ghostCall('t2', 'poster'),
    ]);
    expect([...(map.get('u1') ?? [])]).toEqual(['art']);
    expect([...(map.get('u2') ?? [])]).toEqual(['poster']);
  });

  it('一轮内多个意识去重收集;只提及未调用的 user 不进 map', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      ghostCall('t1', 'art'),
      ghostCall('t2', 'art'),
      ghostCall('t3', 'poster'),
      user('u2'), // 这一轮没有 ghost_call
    ]);
    expect([...(map.get('u1') ?? [])].sort()).toEqual(['art', 'poster']);
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

  it('steer / synthetic user 不夺 turn 边界(归属留在真正的发起 user)', () => {
    const map = collectGhostCallsByUserTurn([
      user('u1'),
      user('s1', { delivery: 'steer' }),
      user('y1', { isSyntheticTrigger: true }),
      ghostCall('t1', 'art'),
    ]);
    expect([...(map.get('u1') ?? [])]).toEqual(['art']);
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
  const mk = (entries: Array<[string, string[]]>): Map<string, Set<string>> =>
    new Map(entries.map(([k, v]) => [k, new Set(v)]));

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
});
