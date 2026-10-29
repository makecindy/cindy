import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../types/events.js';
import { ToolMarkupProjection } from './tool-markup-projection.js';
import { createAsyncQueue } from './async-queue.js';
import { extractRolloutUpdatePlanFunctionCallEvent, translatePlanUpdatedNotification } from '../codex/translator.js';

// #6531 unit: common native output projection, including code-mode asynchronous order.
// Protects cross-response isolation, terminal failure and Stop without executing parsed text.
describe('native projection boundaries', () => {
  it.each([false, true])('never borrows unowned code-mode calls or results (matching=%s)', matching => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection({ requireResponseOwnedCalls: true });
    p.begin(sink);
    p.push({ type: 'tool_use', data: { toolUseId: 'old', toolName: 'read', input: {} } }, sink);
    const markup = '<tool_call>' + JSON.stringify({ name: matching ? 'read' : 'write', arguments: {} }) + '</tool_call>';
    p.push({ type: 'text', data: { text: markup, isFinal: false, agentMessageId: 'new' } }, sink);
    p.push({ type: 'tool_result_full', data: { toolUseId: 'old', fullText: 'old result' } }, sink);
    expect(events.filter(e => e.type === 'text')).toHaveLength(0);
    p.push({ type: 'tool_use', data: { toolUseId: 'old-script-next-call', toolName: 'read', input: {} } }, sink);
    p.push({ type: 'done', data: { status: 'completed' } }, sink);
    expect(events.at(-1)?.data).toMatchObject({ status: 'failed', reason: 'unexecuted-tool-markup' });
    expect(JSON.stringify(events)).not.toContain('<tool_call>');
  });

  it('accepts explicit response-owned evidence while rejecting unowned calls', () => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection({ requireResponseOwnedCalls: true });
    p.begin(sink);
    p.setCalls([{ name: 'read', arguments: {} }]);
    p.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: true } }, sink);
    p.push({ type: 'done', data: { status: 'completed' } }, sink);
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed' });
    expect(events.some(e => e.type === 'error')).toBe(false);
  });
  it('reconciles a recovered sample after a non-terminal retry notice', () => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection(); p.begin(sink);
    p.push({ type: 'error', data: { isTerminal: false, willRetry: true, message: 'reconnecting' } }, sink);
    p.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: true } }, sink);
    p.push({ type: 'done', data: { status: 'completed' } }, sink);
    expect(events.at(-1)?.data).toMatchObject({ status: 'failed', reason: 'unexecuted-tool-markup' });
  });
  // #6545: host-only terminals and translated terminals share the real session
  // queue. Forwarding must not cause a second projection or change event identity.
  it('projects a forwarded SDK terminal only once through the installed queue', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const p = new ToolMarkupProjection();
    p.attachTerminalQueue(queue);
    p.begin(queue);
    p.setCalls([]);
    const forwarded = p.queue({ push: (event: AgentEvent) => queue.push(event) });
    forwarded.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: true } });
    forwarded.push({ type: 'done', data: { status: 'completed' } });
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.data).toMatchObject({ status: 'failed', reason: 'unexecuted-tool-markup' });
  });

  it('ignores background terminals and preserves the host terminal identity and held text', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const p = new ToolMarkupProjection();
    p.attachTerminalQueue(queue);
    p.begin(queue);
    const text = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
    p.queue(queue).push({ type: 'text', data: { text, isFinal: false } });
    const child: AgentEvent = { type: 'done', turnScope: 'background', data: { status: 'completed' } };
    queue.push(child);
    expect(queue.pending).toBe(1);
    const terminal: AgentEvent = { type: 'done', data: { reason: 'stream_end' } };
    queue.push(terminal);
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events).toEqual([child, expect.objectContaining({ type: 'text', data: expect.objectContaining({ text }) }), terminal]);
    expect(events.at(-1)).toBe(terminal);
  });
  // #6545 review: plan snapshots have no tool result and cannot prove that a
  // later sample executed anything. Both production plan entrances are unit-tested.
  it.each(['notification', 'rollout'])('does not use a %s plan snapshot as execution evidence', source => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection();
    p.begin(sink);
    const plan = [{ step: 'Inspect', status: 'pending' as const }];
    if (source === 'notification') {
      translatePlanUpdatedNotification({ threadId: 't', turnId: 'turn', plan }, p.queue(sink) as never);
    } else {
      p.push(extractRolloutUpdatePlanFunctionCallEvent({ type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) }, 'turn')!.event, sink);
    }
    p.push({ type: 'text', data: { text: '<tool_call>' + JSON.stringify({ name: 'update_plan', arguments: { plan } }) + '</tool_call>', isFinal: true } }, sink);
    p.push({ type: 'done', data: { status: 'completed' } }, sink);
    expect(events.filter(e => e.type === 'tool_use')).toHaveLength(1);
    expect(events.at(-1)?.data).toMatchObject({ status: 'failed', reason: 'unexecuted-tool-markup' });
  });
  it('does not use a previous sampling response to validate the next one', () => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection();
    p.begin(sink);
    p.push({ type: 'tool_use', data: { toolUseId: 'c', toolName: 'read', input: {} } }, sink);
    p.push({ type: 'tool_result_full', data: { toolUseId: 'c', fullText: 'done' } }, sink);
    p.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: true, isFullText: true } }, sink);
    p.push({ type: 'done', data: { status: 'completed' } }, sink);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', data: expect.objectContaining({ reason: 'unexecuted-tool-markup' }) }));
  });
  it('waits for later tool evidence before releasing final text, without duplicating the call', () => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection();
    p.begin(sink);
    p.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: true } }, sink);
    expect(events).toEqual([]);
    p.push({ type: 'tool_use', data: { toolUseId: 'c', toolName: 'read', input: {} } }, sink);
    p.push({ type: 'done', data: { status: 'completed' } }, sink);
    expect(events.filter(e => e.type === 'tool_use')).toHaveLength(1);
    expect(events.some(e => e.type === 'error')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('<tool_call>');
  });
  it.each([{ status: 'cancelled' }, { cancelled: true }])('keeps cancellation semantics after a serialized delta: %j', terminal => {
    const events: AgentEvent[] = [];
    const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
    const p = new ToolMarkupProjection();
    p.begin(sink);
    p.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: false } }, sink);
    p.push({ type: 'done', data: terminal }, sink);
    expect(events.some(e => e.type === 'error')).toBe(false);
    expect(events.at(-1)?.data).toEqual(terminal);
    expect(events.find(e => e.type === 'text')?.data).toMatchObject({ text: '<tool_call>{"name":"read","arguments":{}}</tool_call>' });
  });
});

// The native Codex SDK wraps response.failed in a stream-disconnect message.
// Keep the stable reason so live and persisted error cards show the actual failure.
it('restores the stable markup reason after an SDK error wrapper', () => {
  const events: AgentEvent[] = [];
  const p = new ToolMarkupProjection();
  p.push({ type: 'error', data: { message: 'stream disconnected before completion: 模型把工具调用写成了文本，工具未执行，本轮未完成。', isTerminal: true } },
    { push: event => { events.push(event); return true; } });
  expect(events[0].data).toMatchObject({ reason: 'unexecuted-tool-markup', message: '模型把工具调用写成了文本，无法确认执行结果，本轮未完成。', isTerminal: true });
});

it('does not flush or reset a pending candidate on duplicate turn/started', () => {
  const events: AgentEvent[] = [];
  const sink = { push: (event: AgentEvent) => { events.push(event); return true; } };
  const p = new ToolMarkupProjection();
  p.begin(sink, 'turn-1');
  p.push({ type: 'text', data: { text: '<tool_call>{"name":"read","arguments":{}}</tool_call>', isFinal: false } }, sink);
  p.begin(sink, 'turn-1');
  expect(events).toEqual([]);
  p.push({ type: 'tool_use', data: { toolName: 'read', input: {} } }, sink);
  p.push({ type: 'done', data: { status: 'completed' } }, sink);
  expect(events.some(e => e.type === 'error')).toBe(false);
  expect(JSON.stringify(events)).not.toContain('<tool_call>');
});
