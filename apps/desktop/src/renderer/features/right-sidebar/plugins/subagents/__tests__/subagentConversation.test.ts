import { describe, expect, it } from 'vitest';
import type { SubagentTranscriptEntry } from '@cindy/maker-shared/subagent-workspace';

import {
  buildSubagentConversation,
  lastAssistantItemId,
} from '../subagentConversation';

let sequence = 0;
function entry(overrides: Partial<SubagentTranscriptEntry> & { id: string }): SubagentTranscriptEntry {
  sequence += 1;
  return {
    sequence,
    role: 'subagent',
    content: '',
    occurredAt: sequence,
    ...overrides,
  };
}

describe('buildSubagentConversation', () => {
  it('keeps transcript order and routes system rows out of the reading flow', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 'a', role: 'parent', content: 'assignment' }),
      entry({ id: 'b', role: 'system', content: 'runner noise' }),
      entry({ id: 'c', role: 'subagent', content: 'answer' }),
    ]);
    expect(conversation.items.map((item) => [item.kind, item.id])).toEqual([
      ['parent', 'a'],
      ['subagent', 'c'],
    ]);
    expect(conversation.system.map((item) => item.id)).toEqual(['b']);
  });

  it('pairs a tool call by toolCallId into one settled card', () => {
    const conversation = buildSubagentConversation([
      entry({
        id: 'start', role: 'tool', toolPhase: 'start', toolCallId: 'call-1',
        toolName: 'read', content: 'read(/tmp/a.ts)', toolInputJson: '{"file_path":"/tmp/a.ts"}',
      }),
      entry({
        id: 'end', role: 'tool', toolPhase: 'end', toolCallId: 'call-1',
        content: 'file body', isError: false,
      }),
    ]);
    expect(conversation.items).toEqual([
      {
        kind: 'tool',
        id: 'start',
        toolName: 'read',
        summary: 'read(/tmp/a.ts)',
        inputJson: '{"file_path":"/tmp/a.ts"}',
        result: 'file body',
        isError: false,
        done: true,
        occurredAt: expect.any(Number),
      },
    ]);
  });

  it('carries the failure flag from the end half onto the card', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 's', role: 'tool', toolPhase: 'start', toolCallId: 'c', content: 'bash(x)' }),
      entry({ id: 'e', role: 'tool', toolPhase: 'end', toolCallId: 'c', content: '', isError: true }),
    ]);
    expect(conversation.items).toHaveLength(1);
    expect(conversation.items[0]).toMatchObject({ kind: 'tool', done: true, isError: true });
  });

  it('leaves an unmatched start running', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 's', role: 'tool', toolPhase: 'start', toolCallId: 'c', content: 'bash(x)' }),
    ]);
    expect(conversation.items[0]).toMatchObject({ done: false, isError: false });
  });

  it('pairs id-less halves with the nearest still-open card', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 's1', role: 'tool', toolPhase: 'start', content: 'read(a)' }),
      entry({ id: 's2', role: 'tool', toolPhase: 'start', content: 'read(b)' }),
      entry({ id: 'e2', role: 'tool', toolPhase: 'end', content: 'b body' }),
      entry({ id: 'e1', role: 'tool', toolPhase: 'end', content: 'a body' }),
    ]);
    expect(conversation.items).toHaveLength(2);
    expect(conversation.items[0]).toMatchObject({ summary: 'read(a)', result: 'a body' });
    expect(conversation.items[1]).toMatchObject({ summary: 'read(b)', result: 'b body' });
  });

  it('renders an orphan end as its own settled card instead of dropping it', () => {
    const conversation = buildSubagentConversation([
      entry({
        id: 'orphan', role: 'tool', toolPhase: 'end', toolCallId: 'gone',
        toolName: 'bash', content: 'late result', isError: true,
      }),
    ]);
    expect(conversation.items).toEqual([
      {
        kind: 'tool',
        id: 'orphan',
        toolName: 'bash',
        summary: 'bash',
        result: 'late result',
        isError: true,
        done: true,
        occurredAt: expect.any(Number),
      },
    ]);
  });

  it('folds a legacy phase-less tool entry body behind the card instead of into its header', () => {
    // Older device-link hosts serialize the whole harness event into `content`.
    // It must land in the expandable body, or the row is an unreadable truncated
    // one-liner with nothing to open.
    const conversation = buildSubagentConversation([
      entry({ id: 'legacy', role: 'tool', toolName: 'read', content: '{"type":"tool_execution_start"}' }),
    ]);
    expect(conversation.items[0]).toEqual({
      kind: 'tool',
      id: 'legacy',
      toolName: 'read',
      summary: 'read',
      result: '{"type":"tool_execution_start"}',
      isError: false,
      done: true,
      occurredAt: expect.any(Number),
    });
  });

  it('leaves a nameless legacy entry to the card fallback label', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 'legacy', role: 'tool', content: '{"type":"tool_execution_end"}' }),
    ]);
    expect(conversation.items[0]).toMatchObject({
      summary: '',
      result: '{"type":"tool_execution_end"}',
      done: true,
    });
  });

  it('keeps the control action so the renderer can mark the bubble', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 'p', role: 'parent', content: 'also check b', controlAction: 'steer' }),
    ]);
    expect(conversation.items[0]).toMatchObject({ kind: 'parent', controlAction: 'steer' });
  });
});

describe('lastAssistantItemId', () => {
  it('returns the trailing assistant item, ignoring later tool cards', () => {
    const conversation = buildSubagentConversation([
      entry({ id: 'a1', role: 'subagent', content: 'first' }),
      entry({ id: 'a2', role: 'subagent', content: 'second' }),
      entry({ id: 't', role: 'tool', toolPhase: 'start', content: 'read(a)' }),
    ]);
    expect(lastAssistantItemId(conversation.items)).toBe('a2');
  });

  it('returns null when there is no assistant item', () => {
    expect(lastAssistantItemId([])).toBeNull();
  });
});
