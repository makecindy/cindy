import { describe, expect, it } from 'vitest';

import {
  translatePromptResult,
  translateSessionUpdate,
} from '../translator.js';
import type { AcpSessionUpdate } from '../types.js';

describe('grok-build ACP translator', () => {
  it('maps agent_message_chunk to streaming text', () => {
    const update: AcpSessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    };
    expect(translateSessionUpdate(update, {})).toEqual([
      { type: 'text', data: { text: 'hello', isFinal: false }, source: 'grok-build' },
    ]);
  });

  it('maps agent_thought_chunk to thinking', () => {
    const update: AcpSessionUpdate = {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    };
    expect(translateSessionUpdate(update, { thoughtBlockId: 't1' })).toEqual([
      {
        type: 'thinking',
        data: { stage: 'delta', blockId: 't1', text: 'hmm' },
        source: 'grok-build',
      },
    ]);
  });

  it('maps tool_call then completed tool_call_update', () => {
    const start: AcpSessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'bash',
      kind: 'execute',
      rawInput: { command: 'ls' },
    };
    expect(translateSessionUpdate(start, {})).toEqual([
      {
        type: 'tool_use',
        data: { toolUseId: 'tc-1', toolName: 'bash', input: { command: 'ls' } },
        source: 'grok-build',
      },
    ]);
    const done: AcpSessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      title: 'bash',
      status: 'completed',
      rawOutput: 'ok',
    };
    const events = translateSessionUpdate(done, {});
    expect(events.map((e) => e.type)).toEqual(['tool_result_full', 'tool_result']);
    expect(events[0]?.data).toMatchObject({ toolUseId: 'tc-1', content: 'ok', isError: false });
  });

  it('maps usage_update to status', () => {
    const update: AcpSessionUpdate = {
      sessionUpdate: 'usage_update',
      used: 12,
      size: 128000,
      inputTokens: 8,
      outputTokens: 4,
    };
    const events = translateSessionUpdate(update, {});
    expect(events[0]?.type).toBe('status');
    expect(events[0]?.data).toMatchObject({
      status: 'running',
      tokenUsage: 12,
      contextWindow: 128000,
      outputTokens: 4,
    });
  });

  it('maps session/prompt result to done', () => {
    expect(translatePromptResult({ stopReason: 'end_turn' })).toEqual({
      type: 'done',
      data: { stopReason: 'end_turn' },
      source: 'grok-build',
    });
    expect(translatePromptResult({ stopReason: 'cancelled' }).data).toEqual({
      stopReason: 'cancelled',
    });
  });
});
