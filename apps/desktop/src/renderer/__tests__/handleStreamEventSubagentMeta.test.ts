/**
 * handleStreamEventSubagentMeta.test.ts
 * ---------------------------------------------------------------------------
 * subagent-model-chip(A 补全):锁住 handleStreamEvent 把 SDK 事件携带的
 * model / parentUuid 投影到 streaming 阶段的 assistant / thinking 消息上,
 * 使纯文本(零工具)子代理在运行时(尚未重载)也能被 buildSubagentModelMap
 * 命中、显示模型 chip。纯 reducer,node env。
 */

import { describe, it, expect } from 'vitest';

import { handleStreamEvent, EMPTY_SESSION_STATE, makerChatStore } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import { buildRenderItems, buildSubagentModelMap, selectVisibleMessages } from '../components/chat/MessageStream';

const SUBAGENT_META = { parentUuid: 'toolu_AGENT', model: 'claude-haiku-4-5-20251001' };

describe('handleStreamEvent — subagent model/parentToolUseId projection', () => {
  // HY4 的 chatcmpl-tool-* 父调用曾漏过主流过滤；原用例只有 toolu_*，
  // 未覆盖真实 stream → render 和 DB 历史投影 → render 的兼容 ID 分支。
  it.each(['live', 'history'] as const)(
    'hides HY4 child progress while preserving parent and legacy prose (%s)', (mode) => {
      const parentUuid = 'chatcmpl-tool-a1b2c3d4e5f60718';
      const rows = [
        { clientId: 'main', text: 'Main answer', agentMeta: { model: 'tencent/hy4' } },
        { clientId: 'child', text: 'Let me check the remaining details.', agentMeta: { parentUuid, model: 'tencent/hy4' } },
        { clientId: 'legacy', text: 'Legacy answer', agentMeta: { parentUuid: 'preceding-user-uuid' } },
      ];
      const messages = mode === 'history'
        ? makerChatStore.__mapServerMessagesForTest(rows.map(({ clientId, text, agentMeta }) => ({
            id: clientId, clientId, sessionId: 's1', role: 'assistant', content: text,
            createdAt: '2026-11-05T00:00:00.000Z', agentMeta,
          } as Message)))
        : rows.reduce((state, { clientId, text, agentMeta }) => handleStreamEvent(state, {
            sessionId: 's1', type: 'text', persistId: clientId, agentMeta,
            data: { text, isFinal: true },
          }), EMPTY_SESSION_STATE).messages;

      expect(messages.find(message => message.clientId === 'child')?.parentToolUseId).toBe(parentUuid);
      expect(selectVisibleMessages(messages).map(message => message.clientId)).toEqual(['main', 'legacy']);
      expect(buildRenderItems(messages).items.flatMap(item =>
        item.type === 'message' ? [item.message.content] : [],
      )).toEqual(['Main answer', 'Legacy answer']);
      expect(buildSubagentModelMap(messages).get(parentUuid)).toBe('tencent/hy4');
    },
  );

  it('projects onto a live (final) assistant text message → map hits it', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 's1',
      type: 'text',
      data: { text: 'text-only subagent answer', isFinal: true },
      persistId: 'c1',
      agentMeta: SUBAGENT_META,
    });
    const msg = next.messages.find((m) => m.role === 'assistant');
    expect(msg?.model).toBe('claude-haiku-4-5-20251001');
    expect(msg?.parentToolUseId).toBe('toolu_AGENT');
    // end-to-end: the live message feeds the map the chip reads from.
    expect(buildSubagentModelMap(next.messages).get('toolu_AGENT')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('projects onto a live streaming-start assistant text message', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 's1',
      type: 'text',
      data: { text: 'partial', isFinal: false },
      persistId: 'c2',
      agentMeta: SUBAGENT_META,
    });
    const msg = next.messages.find((m) => m.role === 'assistant');
    expect(msg?.model).toBe('claude-haiku-4-5-20251001');
    expect(msg?.parentToolUseId).toBe('toolu_AGENT');
  });

  it('projects onto a live thinking-start message', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 's1',
      type: 'thinking',
      data: { stage: 'start', blockId: 'tb1', startedAt: 1000 },
      agentMeta: SUBAGENT_META,
    });
    const msg = next.messages.find((m) => m.role === 'thinking');
    expect(msg?.model).toBe('claude-haiku-4-5-20251001');
    expect(msg?.parentToolUseId).toBe('toolu_AGENT');
  });

  it('patches the in-flight streaming message when subagent meta only arrives at isFinal', () => {
    // 真实链路:stream-start 的 delta 事件不带 agentMeta(常见),meta 只在 isFinal 这条到达。
    let s = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 's1',
      type: 'text',
      data: { text: 'streaming...', isFinal: false },
      persistId: 'c9',
    });
    expect(s.messages.find((m) => m.role === 'assistant')?.parentToolUseId).toBeUndefined();
    s = handleStreamEvent(s, {
      sessionId: 's1',
      type: 'text',
      data: { text: 'streaming...', isFinal: true },
      persistId: 'c9',
      agentMeta: SUBAGENT_META,
    });
    const msg = s.messages.find((m) => m.role === 'assistant');
    expect(msg?.model).toBe('claude-haiku-4-5-20251001');
    expect(msg?.parentToolUseId).toBe('toolu_AGENT');
    expect(buildSubagentModelMap(s.messages).get('toolu_AGENT')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('patches the thinking message when subagent meta only arrives at thinking final', () => {
    // 纯 thinking(无 text/tool)子代理:start 的 delta 不带 meta,final 这条才带。
    let s = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 's1',
      type: 'thinking',
      data: { stage: 'start', blockId: 'tb9', startedAt: 1000 },
    });
    expect(s.messages.find((m) => m.role === 'thinking')?.parentToolUseId).toBeUndefined();
    s = handleStreamEvent(s, {
      sessionId: 's1',
      type: 'thinking',
      data: { stage: 'final', blockId: 'tb9', text: 'reasoning…', durationMs: 500 },
      agentMeta: SUBAGENT_META,
    });
    const msg = s.messages.find((m) => m.role === 'thinking');
    expect(msg?.model).toBe('claude-haiku-4-5-20251001');
    expect(msg?.parentToolUseId).toBe('toolu_AGENT');
    expect(buildSubagentModelMap(s.messages).get('toolu_AGENT')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('main-thread assistant gets model but no parentToolUseId (stays out of the map)', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: 's1',
      type: 'text',
      data: { text: 'main answer', isFinal: true },
      persistId: 'c3',
      agentMeta: { model: 'claude-opus-4-8' },
    });
    const msg = next.messages.find((m) => m.role === 'assistant');
    expect(msg?.model).toBe('claude-opus-4-8');
    expect(msg?.parentToolUseId).toBeUndefined();
    expect(buildSubagentModelMap(next.messages).size).toBe(0);
  });
});
