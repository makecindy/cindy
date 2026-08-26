/**
 * pi translator 单测 —— 纯函数,验证事件映射正确性(不 spawn pi / 不连网关)。
 * 重点:compaction 边界事件、turn 级 usage 累计与 done 上报、reset 时机。
 */

import { describe, expect, it, vi } from 'vitest';

import { rewriteContextModeDoctorPath } from '../context-mode-doctor-path.js';
import {
  createPiTranslateContext,
  disposePiTranslateContext,
  translatePiEvent,
  usageSnapshotOf,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';
import type { AsyncQueue } from '../../shared/async-queue.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { PiRpcEvent } from '../rpc-client.js';
import { makeGhostManual64KiBFixture } from '../../shared/ghost-manual-fixture.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function makeQueue(): { queue: AsyncQueue<AgentEvent>; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  // translatePiEvent 只调 queue.push;其余 AsyncQueue 接口在此不需要。
  const queue = { push: (e: AgentEvent) => { events.push(e); }, end: () => {} } as unknown as AsyncQueue<AgentEvent>;
  return { queue, events };
}

const ev = (e: Record<string, unknown>): PiRpcEvent => e as unknown as PiRpcEvent;

describe('pi translator', () => {
  it('marks only the Cindy subagent tool as a durable lifecycle', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({ type: 'tool_execution_start', toolCallId: 'sa-1', toolName: 'subagent', args: {} }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'tool_execution_end', toolCallId: 'sa-1', result: 'done', isError: false }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: {} }),
      queue,
      ctx,
    );

    const updates = events.filter((event) => event.type === 'agent_task_update');
    expect(updates.map((event) => event.data)).toEqual([
      expect.objectContaining({
        taskId: 'sa-1',
        status: 'running',
        subagentObservation: expect.objectContaining({ kind: 'spawn' }),
      }),
      expect.objectContaining({
        taskId: 'sa-1',
        status: 'completed',
        subagentObservation: expect.objectContaining({ kind: 'terminal' }),
      }),
    ]);
  });

  it('does not project management commands as Subagent runs', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({
        type: 'tool_execution_start',
        toolCallId: 'sa-list',
        toolName: 'subagent',
        args: { action: 'list' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'tool_execution_end', toolCallId: 'sa-list', result: 'PASS', isError: false }),
      queue,
      ctx,
    );
    expect(events.filter((event) => event.type === 'agent_task_update')).toEqual([]);
  });

  it('uses the explicit value-oriented title for a Subagent run', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({
        type: 'tool_execution_start',
        toolCallId: 'sa-title',
        toolName: 'subagent',
        args: { title: 'Grok 连通性验证', agent: 'worker' },
      }),
      queue,
      ctx,
    );
    expect(events.find((event) => event.type === 'agent_task_update')?.data).toMatchObject({
      title: 'Grok 连通性验证',
    });
  });

  it('derives a batch title from task value instead of role labels', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({
        type: 'tool_execution_start',
        toolCallId: 'sa-batch-title',
        toolName: 'subagent',
        args: {
          tasks: [
            { agent: 'worker', task: 'Verify Grok routing and usage' },
            { agent: 'worker', task: 'Review retry classification' },
          ],
        },
      }),
      queue,
      ctx,
    );
    expect(events.find((event) => event.type === 'agent_task_update')?.data).toMatchObject({
      title: 'Verify Grok routing and usage · Review retry classification',
    });
  });

  it('keeps a durable PI launch receipt running after tool_execution_end', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({ type: 'tool_execution_start', toolCallId: 'sa-bg', toolName: 'subagent', args: { async: true } }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'tool_execution_end',
        toolCallId: 'sa-bg',
        result: {
          content: [{
            type: 'text',
            text: 'Cindy subagent launched. The agent is working in the background.',
          }],
        },
        isError: false,
      }),
      queue,
      ctx,
    );

    const updates = events.filter((event) => event.type === 'agent_task_update');
    expect(updates.at(-1)?.data).toMatchObject({
      taskId: 'sa-bg',
      status: 'running',
      taskType: 'pi_subagent',
    });
  });

  it.each([
    ['failed', false, 'failed'],
    ['stopped', false, 'stopped'],
    ['stopped', true, 'stopped'],
    ['completed', true, 'completed'],
    ['running', true, 'failed'],
  ] as const)(
    'preserves a reported %s Subagent status when the wrapper ends (isError=%s)',
    (reportedStatus, isError, expectedStatus) => {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();

      translatePiEvent(
        ev({ type: 'tool_execution_start', toolCallId: 'sa-1', toolName: 'subagent', args: {} }),
        queue,
        ctx,
      );
      translatePiEvent(
        ev({
          type: 'tool_execution_update',
          toolCallId: 'sa-1',
          partialResult: {
            details: {
              __cindySubagent: 1,
              taskId: 'sa-1',
              status: reportedStatus,
            },
          },
        }),
        queue,
        ctx,
      );
      translatePiEvent(
        ev({ type: 'tool_execution_end', toolCallId: 'sa-1', result: 'done', isError }),
        queue,
        ctx,
      );

      const updates = events.filter((event) => event.type === 'agent_task_update');
      expect(updates.at(-1)?.data).toMatchObject({
        taskId: 'sa-1',
        status: expectedStatus,
        subagentObservation: expect.objectContaining({ kind: 'terminal' }),
      });
    },
  );

  it('emits live assistant deltas before the authoritative final text', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
          model: 'xai/grok-4.5',
          stopReason: 'stop',
        },
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', data: { text: 'Hello ', isFinal: false }, source: 'pi' },
      { type: 'text', data: { text: 'world', isFinal: false }, source: 'pi' },
      expect.objectContaining({
        type: 'text',
        data: { text: 'Hello world', isFinal: true, isFullText: true },
        source: 'pi',
      }),
    ]);
  });

  it('does not emit a leaked Grok stop token split across PI deltas', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '<|eo' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'answer' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 's|>' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '<|eos|>' },
            { type: 'text', text: 'answer' },
          ],
          model: 'xai/grok-4.6',
          stopReason: 'stop',
        },
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', data: { text: 'answer', isFinal: false }, source: 'pi' },
      expect.objectContaining({
        type: 'text',
        data: { text: 'answer', isFinal: true, isFullText: true },
        source: 'pi',
      }),
    ]);
  });

  it('does not emit a leaked Grok stop token split as a single-character prefix', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '<' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '|eos|>' },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '<|eos|>' }],
          model: 'xai/grok-4.6',
          stopReason: 'stop',
        },
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'text')).toEqual([]);
  });

  it('surfaces a terminal provider error after Pi settles instead of staying in Working', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    const rawError =
      'HTTP 400: third-party apps draw from extra usage. Authorization: Bearer secret-token';

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: rawError,
          usage: { input: 0, output: 0 },
        },
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        source: 'pi',
        data: expect.objectContaining({
          message: 'HTTP 400: third-party apps draw from extra usage. Authorization: [REDACTED]',
          isTerminal: true,
        }),
      }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', source: 'pi' }));
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'status',
      data: expect.objectContaining({ status: 'Done', isRunning: false }),
    }));
  });

  it('drops a pending provider error when Pi auto-retry succeeds', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'HTTP status 529: overloaded',
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        errorMessage: 'HTTP status 529: overloaded',
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered answer' }],
          stopReason: 'stop',
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'auto_retry_end', success: true }), queue, ctx);
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    // 第一次自动重试保持静默：一次抖动就恢复时不该闪红色错误条。
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect((events.find((event) => event.type === 'done')?.data as { result?: string }).result)
      .toBe('Recovered answer');
  });

  it('maps later Pi auto-retries onto the shared overload retry protocol', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        errorMessage: 'HTTP status 529: overloaded',
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        type: 'error',
        source: 'pi',
        data: expect.objectContaining({
          message: 'HTTP status 529: overloaded (auto-retry 2/3)',
          isTerminal: false,
          willRetry: true,
          reason: 'upstream-overload',
          errorStatus: 529,
        }),
      }),
    ]);
  });

  it('classifies LiteLLM Response API in-stream errors without auto-retry markers', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    const rawError =
      'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}';

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: rawError,
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        source: 'pi',
        data: expect.objectContaining({
          message: rawError,
          isTerminal: true,
          reason: 'upstream-stream-interrupted',
        }),
      }),
    ]);
  });

  it('keeps LiteLLM in-stream auto-retries silent instead of reusing the overload marker', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        errorMessage: 'litellm.APIError: Response API in-stream error',
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('keeps unclassified Pi auto-retries silent instead of reusing the overload marker', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        errorMessage: 'provider 500 from upstream',
      }),
      queue,
      ctx,
    );

    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('does not duplicate a terminal error after Pi auto-retry is exhausted', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'initial provider error',
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'auto_retry_end', success: false, finalError: 'final provider error' }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const terminalErrors = events.filter(
      (event) =>
        event.type === 'error' &&
        (event.data as { isTerminal?: boolean }).isTerminal === true,
    );
    expect(terminalErrors).toHaveLength(1);
    expect(terminalErrors[0]?.data).toMatchObject({ message: 'final provider error' });
  });

  it('tags a terminal xAI prompt-length error as context-overflow', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    const overflow =
      'API Error: 400 litellm.BadRequestError: XaiException - {"code":"invalid-argument","error":"This model\'s maximum prompt length is 500000 but the request contains 637815 tokens."}';

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: overflow,
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const terminalErrors = events.filter(
      (event) =>
        event.type === 'error' &&
        (event.data as { isTerminal?: boolean }).isTerminal === true,
    );
    expect(terminalErrors).toHaveLength(1);
    expect(terminalErrors[0]?.data).toMatchObject({
      isTerminal: true,
      reason: 'context-overflow',
    });
  });

  it('does not tag a generic invalid-argument as context-overflow', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '{"code":"invalid-argument","error":"unsupported field: foo"}',
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const terminalErrors = events.filter(
      (event) =>
        event.type === 'error' &&
        (event.data as { isTerminal?: boolean }).isTerminal === true,
    );
    expect(terminalErrors).toHaveLength(1);
    expect((terminalErrors[0]?.data as { reason?: string }).reason).toBeUndefined();
  });

  it('preserves a 64KB ghost_manual envelope only as tool_result data', () => {
    const { content, wire } = makeGhostManual64KiBFixture();
    expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(64 * 1024);

    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({
        type: 'tool_execution_end',
        toolCallId: 'manual-call',
        toolName: 'ghost_manual',
        result: { content: [{ type: 'text', text: wire }] },
      }),
      queue,
      ctx,
    );
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full).toMatchObject({ data: { fullText: wire }, source: 'pi' });
    expect(JSON.parse((full!.data as { fullText: string }).fullText).content).toBe(content);
  });

  it('rewrites context-mode doctor tool results to the Cindy-managed package path', () => {
    const root = '/tmp/cindy/managed-packages/0/node_modules/context-mode';
    const ctx = createPiTranslateContext(noopLogger);
    ctx.rewriteToolResultText = (text) => rewriteContextModeDoctorPath(text, root);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({
        type: 'tool_execution_end',
        toolCallId: 'doctor-1',
        toolName: 'ctx_doctor',
        result: {
          content: [
            {
              type: 'text',
              text: '[OK] Hook support: (~/.pi/extensions/context-mode/), not via JSON-stdio.',
            },
          ],
        },
      }),
      queue,
      ctx,
    );
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full).toMatchObject({
      data: {
        fullText: `[OK] Hook support: (${root}/), not via JSON-stdio.`,
      },
    });
  });

  it('leaves non-doctor tool results containing the stale path unchanged', () => {
    const root = '/tmp/cindy/managed-packages/0/node_modules/context-mode';
    const stale = '[OK] Hook support: (~/.pi/extensions/context-mode/), not via JSON-stdio.';
    const ctx = createPiTranslateContext(noopLogger);
    ctx.rewriteToolResultText = (text) => rewriteContextModeDoctorPath(text, root);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: {} }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        result: { content: [{ type: 'text', text: stale }] },
      }),
      queue,
      ctx,
    );
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full).toMatchObject({ data: { fullText: stale } });
  });

  it('maps compaction_end (threshold) → compact_boundary with token deltas + updates contextTokens', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000, estimatedTokensAfter: 32000 } }),
      queue,
      ctx,
    );
    const cb = events.find((e) => e.type === 'compact_boundary');
    expect(cb).toBeDefined();
    const data = cb!.data as { trigger: string; preTokens?: number; postTokens?: number };
    expect(data.trigger).toBe('auto');
    expect(data.preTokens).toBe(150000);
    expect(data.postTokens).toBe(32000);
    expect(ctx.contextTokens).toBe(32000);
  });

  it('maps manual compaction trigger through to compact_boundary', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 100, estimatedTokensAfter: 20 } }),
      queue,
      ctx,
    );
    const cb = events.find((e) => e.type === 'compact_boundary');
    expect((cb!.data as { trigger: string }).trigger).toBe('manual');
  });

  it('#1933 review:manual compaction 事件闭环 —— 收口 running 并把新 contextTokens 送回 renderer', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    // compaction_start 先把 running 置 true(与 pi 事件流一致)。
    translatePiEvent(ev({ type: 'compaction_start' }), queue, ctx);
    const startStatus = events.find(
      (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === true,
    );
    expect(startStatus).toBeDefined();
    expect(startStatus?.turnScope).toBe('background');

    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 100, estimatedTokensAfter: 20 } }),
      queue,
      ctx,
    );
    // 闭环:manual compaction_end 必须补发 status(isRunning=false, Done),
    // 携带压缩后的 contextTokens —— 否则 renderer 圆环永久卡 running、token 不刷新。
    const endStatus = events.find(
      (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
    );
    expect(endStatus).toBeDefined();
    const endData = endStatus!.data as { status: string; contextTokens?: number };
    expect(endData.status).toBe('Done');
    expect(endData.contextTokens).toBe(20);
    expect(endStatus?.turnScope).toBe('background');
  });

  it('marks idle manual compaction status as background so it cannot latch a product turn', () => {
    const ctx = createPiTranslateContext(noopLogger);
    ctx.isStreaming = false;
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'compaction_start' }), queue, ctx);
    const start = events.find((e) => e.type === 'status');
    expect(start).toMatchObject({
      turnScope: 'background',
      data: expect.objectContaining({ isRunning: true, status: 'Compacting context…' }),
    });
  });

  it('does not mark in-turn compaction_start as background', () => {
    const ctx = createPiTranslateContext(noopLogger);
    ctx.isStreaming = true;
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'compaction_start' }), queue, ctx);
    const start = events.find((e) => e.type === 'status');
    expect(start).toBeDefined();
    expect(start?.turnScope).toBeUndefined();
  });

  it('keeps idle compact_boundary background after a new turn starts mid-compact', () => {
    const ctx = createPiTranslateContext(noopLogger);
    ctx.isStreaming = false;
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'compaction_start', reason: 'threshold' }), queue, ctx);
    expect(events.find((e) => e.type === 'status')?.turnScope).toBe('background');

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    expect(ctx.isStreaming).toBe(true);

    translatePiEvent(
      ev({
        type: 'compaction_end',
        reason: 'threshold',
        result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
      }),
      queue,
      ctx,
    );
    const boundary = events.find((e) => e.type === 'compact_boundary');
    expect(boundary?.turnScope).toBe('background');
    expect(
      events.filter(
        (e) => e.type === 'status' && (e.data as { status?: string }).status === 'Done',
      ),
    ).toHaveLength(0);
  });

  it('does not relabel an in-turn compact_boundary as background if streaming later stops', () => {
    const ctx = createPiTranslateContext(noopLogger);
    ctx.isStreaming = true;
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'compaction_start', reason: 'threshold' }), queue, ctx);
    ctx.isStreaming = false;
    translatePiEvent(
      ev({
        type: 'compaction_end',
        reason: 'threshold',
        result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
      }),
      queue,
      ctx,
    );
    const boundary = events.find((e) => e.type === 'compact_boundary');
    expect(boundary).toBeDefined();
    expect(boundary?.turnScope).toBeUndefined();
  });

  it('#1933 review:auto compaction 在活跃 turn 内不补发 status(false)(不得误收口 turn)', () => {
    const ctx = createPiTranslateContext(noopLogger);
    ctx.isStreaming = true; // auto compaction 发生在活跃 turn 内
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000, estimatedTokensAfter: 32000 } }),
      queue,
      ctx,
    );
    // 只有 compact_boundary,没有 status 收口(turn 结束经 agent_settled 自然收口)。
    expect(events.filter((e) => e.type === 'status')).toHaveLength(0);
    expect(events.some((e) => e.type === 'compact_boundary')).toBe(true);
    // 即便 manual 压缩期间用户已开始新 turn(isStreaming),也不收口。
    const ctx2 = createPiTranslateContext(noopLogger);
    ctx2.isStreaming = true;
    const { queue: q2, events: ev2 } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 100, estimatedTokensAfter: 20 } }),
      q2,
      ctx2,
    );
    expect(ev2.filter((e) => e.type === 'status')).toHaveLength(0);
  });

  it('does not emit compact_boundary for aborted or failed compaction_end', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'compaction_start', reason: 'threshold' }), queue, ctx);
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'threshold', result: null, aborted: true }),
      queue,
      ctx,
    );
    expect(events.some((e) => e.type === 'compact_boundary')).toBe(false);

    const ctx2 = createPiTranslateContext(noopLogger);
    const { queue: q2, events: ev2 } = makeQueue();
    translatePiEvent(
      ev({
        type: 'compaction_end',
        reason: 'manual',
        result: null,
        aborted: false,
        errorMessage: 'quota exceeded',
      }),
      q2,
      ctx2,
    );
    expect(ev2.some((e) => e.type === 'compact_boundary')).toBe(false);
    const endStatus = ev2.find(
      (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
    );
    expect(endStatus).toBeDefined();
  });

  it('accumulates turn usage and attaches it to the done event on agent_settled', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
          duration: 1_200,
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const usage = (done!.data as { usage: Record<string, unknown> }).usage;
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadTokens).toBe(5);
    expect(usage.cacheCreationTokens).toBe(3);
    expect(usage.segmentsComplete).toBe(true);
    expect(usage.segments).toEqual([
      expect.objectContaining({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreateTokens: 3,
      }),
    ]);
    expect(usage.durationMs).toBeGreaterThanOrEqual(1_200);
    expect(usage.turnDurationMs).toBeGreaterThanOrEqual(0);
    // 快照累计 input+output。
    expect(usageSnapshotOf(ctx).tokenUsage).toBe(120);
    expect(usageSnapshotOf(ctx).outputTokens).toBe(20);
    expect(usageSnapshotOf(ctx).generationReliable).toBe(true);
    expect(usageSnapshotOf(ctx).generationDurationMs).toBe(1_200);
    expect(usageSnapshotOf(ctx).generationActive).toBe(false);
    // done.data.result 带上最终回复文本 —— register.ts 的 will-assistant-message 出口钩子
    // 与 Orca worker 终态 finalText 都读它,不带上就对 Pi 静默跳过(codex review P1)。
    expect((done!.data as { result?: unknown }).result).toBe('hi');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      data: expect.objectContaining({ status: 'Done', isRunning: false }),
    }));
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('locks the Pi price variant from bridge usage metadata at each provider request boundary', () => {
    const ctx = createPiTranslateContext(noopLogger);
    let fast = false;
    ctx.getPriceVariant = () => (fast ? 'priority' : 'standard');
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({ type: 'message_start', message: { usage: { service_tier: 'default' } } }),
      queue,
      ctx,
    );
    fast = true;
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'gpt-5.6-sol',
          content: [{ type: 'text', text: 'standard request' }],
          usage: { input: 10, output: 2, service_tier: 'default' },
        },
      }),
      queue,
      ctx,
    );

    translatePiEvent(
      ev({ type: 'message_start', message: { usage: { service_tier: 'priority' } } }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'gpt-5.6-sol',
          content: [{ type: 'text', text: 'priority request' }],
          usage: { input: 20, output: 3, service_tier: 'priority' },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const usage = (events.find((event) => event.type === 'done')!.data as {
      usage: { segments: Array<{ priceVariant?: string }> };
    }).usage;
    expect(usage.segments.map((segment) => segment.priceVariant)).toEqual([
      'standard',
      'priority',
    ]);
  });

  it('marks generation active on message_start so the UI can tick live TPS', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    expect(usageSnapshotOf(ctx).generationActive).toBe(true);
    expect(usageSnapshotOf(ctx).generationReliable).toBe(true);
    expect(events.filter((e) => e.type === 'status')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'status',
          data: expect.objectContaining({
            status: 'Working…',
            isRunning: true,
            generationActive: true,
          }),
        }),
      ]),
    );
    disposePiTranslateContext(ctx);
  });

  it('reads Pi v0.83 generation duration from timestamp with a live heartbeat', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    const timestamp = Date.now() - 1_200;
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer after a tool' }],
          usage: { input: 10, output: 5 },
          timestamp,
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    const usage = (events.find((e) => e.type === 'done')!.data as { usage: Record<string, unknown> }).usage;
    expect(usage.durationMs).toEqual(expect.any(Number));
    expect(usage.durationMs).toBeGreaterThanOrEqual(1_200);
    expect(usage.turnDurationMs).toEqual(expect.any(Number));
  });

  it('omits timestamp-derived timing after a suspend-sized heartbeat gap', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
      nowSpy.mockReturnValue(40_000);
      translatePiEvent(
        ev({
          type: 'message_end',
          message: { role: 'assistant', content: [], usage: { output: 5 }, timestamp: 1_000 },
        }),
        queue,
        ctx,
      );
      translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
      const usage = (events.find((e) => e.type === 'done')!.data as { usage: Record<string, unknown> }).usage;
      expect(usage).not.toHaveProperty('durationMs');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('omits timing when one of multiple output messages lacks duration', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: { role: 'assistant', content: [], usage: { output: 10 }, duration: 500 },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_end',
        message: { role: 'assistant', content: [], usage: { output: 5 } },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const usage = (events.find((e) => e.type === 'done')!.data as { usage: Record<string, unknown> }).usage;
    expect(usage.outputTokens).toBe(15);
    expect(usage).not.toHaveProperty('durationMs');
  });

  it('done.result carries the last assistant message text (multi-message turn) and resets per turn', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    // 文本 → 纯 tool_call(无文本)→ 最终文本:result 应取最后一条有文本的回复。
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking…' }], usage: { input: 10, output: 2 } } }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }], usage: { input: 5, output: 1 } } }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], usage: { input: 5, output: 3 } } }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    const done = events.find((e) => e.type === 'done');
    expect((done!.data as { result?: unknown }).result).toBe('final answer');

    // 新 turn:result 归零,不带上一 turn 的回复。
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    expect(ctx.finalAssistantText).toBe('');
    const events2 = makeQueue();
    translatePiEvent(ev({ type: 'agent_settled' }), events2.queue, ctx);
    const done2 = events2.events.find((e) => e.type === 'done');
    expect((done2!.data as { result?: unknown }).result).toBe('');
  });

  it('resets turn usage counters on the next agent_start', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 50, output: 10 } } }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    expect(ctx.turnInput).toBe(50);

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx); // 新 turn 重置
    expect(ctx.turnInput).toBe(0);
    expect(ctx.turnOutput).toBe(0);
    expect(ctx.turnCacheRead).toBe(0);
    expect(ctx.turnCacheWrite).toBe(0);
  });

  it('preserves pi redacted thinking as a structured redacted event', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex: 0,
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '', redacted: true }],
          },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: '[Reasoning redacted]',
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }],
          },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: '[Reasoning redacted]',
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }],
          },
        },
      }),
      queue,
      ctx,
    );

    expect(events.filter((e) => e.type === 'thinking')).toEqual([{
      type: 'thinking',
      data: { stage: 'redacted', blockId: 'pi-think-1' },
      source: 'pi',
    }]);
    disposePiTranslateContext(ctx);
  });

  it('cleans up a visible placeholder when redaction is only known at thinking_end', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex: 0,
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '' }],
          },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: '[Reasoning redacted]',
        },
      }),
      queue,
      ctx,
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'thinking',
        data: expect.objectContaining({ stage: 'start', blockId: 'pi-think-1' }),
      }),
      {
        type: 'thinking',
        data: { stage: 'redacted', blockId: 'pi-think-1' },
        source: 'pi',
      },
    ]);
  });

  it('keeps interleaved text and multiple redacted blocks in one assistant message hidden', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    const firstPartialContent = [
      { type: 'text', text: 'first section' },
      { type: 'thinking', thinking: '[Reasoning redacted]', redacted: true },
    ];
    const secondPartialContent = [
      ...firstPartialContent,
      { type: 'text', text: 'second section' },
      { type: 'thinking', thinking: '[Reasoning redacted]', redacted: true },
    ];

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(ev({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'first section' },
    }), queue, ctx);
    for (const [contentIndex, content] of [
      [1, firstPartialContent],
      [3, secondPartialContent],
    ] as const) {
      translatePiEvent(ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex,
          partial: { role: 'assistant', content },
        },
      }), queue, ctx);
      translatePiEvent(ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex,
          content: '[Reasoning redacted]',
          partial: { role: 'assistant', content },
        },
      }), queue, ctx);
      if (contentIndex === 1) {
        translatePiEvent(ev({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'second section' },
        }), queue, ctx);
      }
    }
    translatePiEvent(ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: secondPartialContent,
        model: 'xai/grok-4.5',
        stopReason: 'stop',
      },
    }), queue, ctx);

    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      {
        type: 'thinking',
        data: { stage: 'redacted', blockId: 'pi-think-1' },
        source: 'pi',
      },
      {
        type: 'thinking',
        data: { stage: 'redacted', blockId: 'pi-think-2' },
        source: 'pi',
      },
    ]);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', data: { text: 'first section', isFinal: false }, source: 'pi' },
      { type: 'text', data: { text: 'second section', isFinal: false }, source: 'pi' },
      expect.objectContaining({
        type: 'text',
        data: { text: 'first section\n\nsecond section', isFinal: true, isFullText: true },
      }),
    ]);
  });

  it('keeps ordinary pi thinking_end as visible final thinking', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'visible reasoning',
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'visible reasoning' }],
          },
        },
      }),
      queue,
      ctx,
    );

    expect(events.at(-1)).toEqual({
      type: 'thinking',
      data: expect.objectContaining({
        stage: 'final',
        blockId: 'pi-think-1',
        text: 'visible reasoning',
      }),
      source: 'pi',
    });
  });

  it('accepts the thinking-level status notification without warning', () => {
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };
    const ctx = createPiTranslateContext(logger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({ type: 'thinking_level_changed', thinkingLevel: 'high' }),
      queue,
      ctx,
    );

    expect(events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('delegated (subagent) usage accounting', () => {
    const progressEvent = (taskId: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
      ev({
        type: 'tool_execution_update',
        toolCallId: taskId,
        partialResult: {
          details: { __cindySubagent: 1, taskId, status: 'running', usage, ...extra },
        },
      });

    it('folds subagent usage into the turn totals and done.data.usage', () => {
      // 子代理是独立 pi 进程,它的请求不经过父进程的 usage 流。不显式并进来,done.data.usage
      // 与 register.ts 持久化的 session token/cost 会漏掉全部委派花费(review)。
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);

      translatePiEvent(
        progressEvent('sa-1', { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: 0.01 }),
        queue,
        ctx,
      );
      expect(ctx.turnInput).toBe(100);
      expect(ctx.turnOutput).toBe(20);
      expect(ctx.turnCacheRead).toBe(5);
      expect(ctx.turnCacheWrite).toBe(2);
      expect(ctx.turnTokens).toBe(120);
      expect(ctx.costUsd).toBeCloseTo(0.01, 10);
      // 卡片帧照旧发出(用量记账是附加行为,不替代卡片)。
      expect(events.some((e) => e.type === 'agent_task_update')).toBe(true);

      translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
      const done = events.find((e) => e.type === 'done');
      expect((done?.data as { usage?: unknown }).usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
      });
      expect(
        (done?.data as { usage?: { turnDurationMs?: unknown } }).usage?.turnDurationMs,
      ).toEqual(expect.any(Number));
      expect((done?.data as { usage?: Record<string, unknown> }).usage).not.toHaveProperty(
        'durationMs',
      );
    });

    it('omits parent-only timing after delegated output joins the turn', () => {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      translatePiEvent(
        ev({
          type: 'message_end',
          message: { role: 'assistant', content: [], usage: { output: 10 }, duration: 1_000 },
        }),
        queue,
        ctx,
      );
      translatePiEvent(progressEvent('sa-1', { input: 100, output: 20 }), queue, ctx);
      translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

      const usage = (events.find((e) => e.type === 'done')!.data as { usage: Record<string, unknown> }).usage;
      expect(usage.outputTokens).toBe(30);
      expect(usage).not.toHaveProperty('durationMs');
    });

    it('only counts the increment — progress frames report cumulative totals', () => {
      // 进度帧报累计值(丢一帧不该让那段用量永久消失),所以父侧必须按 taskId 作差。
      // 直接累加会让同一批 token 被反复计入,一次多帧的委派就能把 turn 用量翻好几倍。
      const ctx = createPiTranslateContext(noopLogger);
      const { queue } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);

      translatePiEvent(progressEvent('sa-1', { input: 100, output: 10, cost: 0.01 }), queue, ctx);
      translatePiEvent(progressEvent('sa-1', { input: 250, output: 40, cost: 0.03 }), queue, ctx);
      translatePiEvent(progressEvent('sa-1', { input: 250, output: 40, cost: 0.03 }), queue, ctx);

      expect(ctx.turnInput).toBe(250);
      expect(ctx.turnOutput).toBe(40);
      expect(ctx.turnTokens).toBe(290);
      expect(ctx.costUsd).toBeCloseTo(0.03, 10);
    });

    it('deduplicates child request segments across cumulative progress frames', () => {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      const segments = [
        {
          id: 'r1',
          model: 'gpt-5.5',
          input: 100,
          output: 10,
          cacheRead: 5,
          cacheWrite: 0,
          cost: 0.01,
        },
        {
          id: 'r2',
          model: 'gpt-5.5',
          input: 200,
          output: 20,
          cacheRead: 15,
          cacheWrite: 0,
          cost: 0.02,
        },
      ];
      translatePiEvent(
        progressEvent(
          'sa-1',
          { input: 300, output: 30, cacheRead: 20, cost: 0.03 },
          { usageSegments: segments },
        ),
        queue,
        ctx,
      );
      translatePiEvent(
        progressEvent(
          'sa-1',
          { input: 300, output: 30, cacheRead: 20, cost: 0.03 },
          { usageSegments: segments },
        ),
        queue,
        ctx,
      );
      translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

      expect(ctx.turnInput).toBe(300);
      expect(ctx.turnOutput).toBe(30);
      expect(ctx.costUsd).toBeCloseTo(0.03, 10);
      const usage = (
        events.find((event) => event.type === 'done')!.data as { usage: Record<string, unknown> }
      ).usage;
      expect(usage.segmentsComplete).toBe(true);
      expect(usage.segments).toHaveLength(2);
    });

    it('falls back to token-only accounting when child segments do not cover the cumulative total', () => {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      translatePiEvent(
        progressEvent(
          'sa-1',
          { input: 300, output: 30, cacheRead: 20, cost: 0.03 },
          {
            usageSegments: [
              { id: 'r1', model: 'gpt-5.5', input: 100, output: 10, cacheRead: 5, cost: 0.01 },
            ],
          },
        ),
        queue,
        ctx,
      );
      translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

      expect(ctx.turnInput).toBe(300);
      expect(ctx.turnOutput).toBe(30);
      const usage = (
        events.find((event) => event.type === 'done')!.data as { usage: Record<string, unknown> }
      ).usage;
      expect(usage.segmentsComplete).toBe(false);
      expect(usage.segments).toEqual([]);
    });

    it('accumulates parallel delegations independently and never goes negative', () => {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);

      translatePiEvent(progressEvent('sa-1', { input: 100, output: 10, cost: 0.01 }), queue, ctx);
      translatePiEvent(progressEvent('sa-2', { input: 200, output: 30, cost: 0.02 }), queue, ctx);
      // 回退的累计值(理论上不该出现)不得产生负增量。
      translatePiEvent(progressEvent('sa-2', { input: 5, output: 1, cost: 0 }), queue, ctx);

      expect(ctx.turnInput).toBe(300);
      expect(ctx.turnOutput).toBe(40);
      expect(ctx.costUsd).toBeCloseTo(0.03, 10);
    });

    it('does not pollute contextTokens with the subagent context', () => {
      // contextTokens = "最后一次 API 调用占了多少上下文"。子代理有自己独立的上下文窗口,
      // 混进来会让父会话的上下文占用条虚高。
      const ctx = createPiTranslateContext(noopLogger);
      const { queue } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      translatePiEvent(
        ev({
          type: 'message_end',
          message: { role: 'assistant', content: [], usage: { input: 1_000, cacheRead: 500, cacheWrite: 0, output: 5 } },
        }),
        queue,
        ctx,
      );
      const parentContext = ctx.contextTokens;
      expect(parentContext).toBe(1_500);

      translatePiEvent(progressEvent('sa-1', { input: 90_000, output: 9_000 }), queue, ctx);
      expect(ctx.contextTokens).toBe(parentContext);
    });

    it('resets the delegated cumulative bookkeeping at the turn boundary', () => {
      // 新 turn 的累计值不该跟上一 turn 作差(否则新 turn 的委派用量被吃掉);
      // 也避免长会话里 taskId 条目无界堆积。
      const ctx = createPiTranslateContext(noopLogger);
      const { queue } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      translatePiEvent(progressEvent('sa-1', { input: 100, output: 10 }), queue, ctx);
      translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      expect(ctx.delegatedUsage.size).toBe(0);
      translatePiEvent(progressEvent('sa-1', { input: 100, output: 10 }), queue, ctx);
      expect(ctx.turnInput).toBe(100);
      expect(ctx.turnOutput).toBe(10);
    });

    it('ignores progress frames without usage (card-only updates)', () => {
      const ctx = createPiTranslateContext(noopLogger);
      const { queue, events } = makeQueue();
      translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
      translatePiEvent(
        ev({
          type: 'tool_execution_update',
          toolCallId: 'sa-1',
          partialResult: { details: { __cindySubagent: 1, taskId: 'sa-1', status: 'running', toolUses: 3 } },
        }),
        queue,
        ctx,
      );
      expect(ctx.turnInput).toBe(0);
      expect(ctx.turnTokens).toBe(0);
      expect(events.some((e) => e.type === 'agent_task_update')).toBe(true);
      expect(usageSnapshotOf(ctx).tokenUsage).toBe(0);
    });
  });
});
