/**
 * errorRetryTokenPreserved.test.ts
 * ---------------------------------------------------------------------------
 * ErrorBanner「重试」按钮消失回归(2026-07-13 "Request timed out" 只剩取消按钮):
 * main coordinator 在终止型 error 时先同步 emit projection(带权威 retry token),
 * renderer 的 error 事件 reducer 随后执行。此前 reducer 用本地推导值
 * (deriveErrorRetryText,只覆盖 renderer 直发 turn)覆写 errorRetryText,把
 * projection 刚落地的 token 盖成 null —— main drain 派发的 turn(排队消息、
 * 纯附件/语音)报错时 Retry 按钮因此蒸发。锁住:本地推导为 null 时保留已有 token。
 * 纯 reducer,node env。
 */

import { describe, it, expect } from 'vitest';

import { handleStreamEvent, EMPTY_SESSION_STATE } from '@/lib/makerChatStore';
import type { QueuedMessage } from '@/lib/makerChatStore';

const SESSION_ID = 's1';

const PROJECTION_TOKEN = '__xdt_queue_retry__:client-1';

function terminalError(message = 'Request timed out'): Parameters<typeof handleStreamEvent>[1] {
  return {
    sessionId: SESSION_ID,
    type: 'error',
    data: { message, isTerminal: true },
  } as Parameters<typeof handleStreamEvent>[1];
}

function queuedRow(clientId: string): QueuedMessage {
  return {
    clientId,
    text: 'queued tail',
    chatMessage: {
      clientId,
      role: 'user',
      content: 'queued tail',
      createdAt: '2026-07-13T00:00:00.000Z',
    },
  } as unknown as QueuedMessage;
}

describe('handleStreamEvent — terminal error keeps the projection retry token', () => {
  it('preserves a projection-provided token when local derivation is null (main-drained turn)', () => {
    // main drain 派发的 turn:renderer 没走 markDispatchStarted,
    // activeTurnRetryText 为 null;projection 已先把 token 写进 state。
    const before = {
      ...EMPTY_SESSION_STATE,
      error: 'Request timed out',
      errorRetryText: PROJECTION_TOKEN,
      activeTurnRetryText: null,
      isStreaming: true,
    };

    const next = handleStreamEvent(before, terminalError());

    expect(next.error).toBe('Request timed out');
    expect(next.errorRetryText).toBe(PROJECTION_TOKEN);
  });

  it('preserves the token even with tail rows queued behind the failed turn', () => {
    // 队列非空时 deriveErrorRetryText 恒为 null(防重发排队 bug),
    // 但 active-turn 恢复的 token 本就不指向队首,不能因此丢掉。
    const before = {
      ...EMPTY_SESSION_STATE,
      error: 'Request timed out',
      errorRetryText: PROJECTION_TOKEN,
      activeTurnRetryText: 'typed text',
      pendingQueue: [queuedRow('tail-1')],
      isStreaming: true,
    };

    const next = handleStreamEvent(before, terminalError());

    expect(next.errorRetryText).toBe(PROJECTION_TOKEN);
  });

  it('still prefers the locally derived text for renderer-direct dispatches', () => {
    const before = {
      ...EMPTY_SESSION_STATE,
      activeTurnRetryText: 'typed text',
      isStreaming: true,
    };

    const next = handleStreamEvent(before, terminalError());

    expect(next.errorRetryText).toBe('typed text');
  });

  it('stays null when neither projection token nor local derivation exists', () => {
    const before = { ...EMPTY_SESSION_STATE, isStreaming: true };

    const next = handleStreamEvent(before, terminalError());

    expect(next.error).toBe('Request timed out');
    expect(next.errorRetryText).toBeNull();
  });

  it('keeps recoverable (non-terminal) errors clearing the token as before', () => {
    const before = {
      ...EMPTY_SESSION_STATE,
      errorRetryText: PROJECTION_TOKEN,
      errorPersistId: 'old-persist',
      isStreaming: true,
    };

    const next = handleStreamEvent(before, {
      sessionId: SESSION_ID,
      type: 'error',
      data: { message: 'transient', isTerminal: false },
    } as Parameters<typeof handleStreamEvent>[1]);

    expect(next.errorRetryText).toBeNull();
    expect(next.errorPersistId).toBeNull();
    expect(next.recoverableError).toBe('transient');
  });

  it('copies persistId from the terminal error event', () => {
    const next = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, isStreaming: true },
      { ...terminalError(), persistId: 'err_persist_1' },
    );

    expect(next.error).toBe('Request timed out');
    expect(next.errorPersistId).toBe('err_persist_1');
    // persistId 只绑定即将落库的 error 行，不是 Retry 依据。
    expect(next.errorRetryText).toBeNull();
  });

  it('keeps an existing persistId when a duplicate terminal event omits it', () => {
    const before = {
      ...EMPTY_SESSION_STATE,
      error: 'Request timed out',
      errorPersistId: 'err_persist_1',
      isStreaming: true,
    };

    const next = handleStreamEvent(before, terminalError());

    expect(next.errorPersistId).toBe('err_persist_1');
  });

  it('replaces the binding when a later terminal event carries a new persistId', () => {
    const before = {
      ...EMPTY_SESSION_STATE,
      error: 'old error',
      errorPersistId: 'old-id',
      isStreaming: true,
    };

    const next = handleStreamEvent(before, {
      ...terminalError(),
      persistId: 'err_persist_2',
    });

    expect(next.errorPersistId).toBe('err_persist_2');
  });

  it('projects structured tool-loop details from terminal guard errors', () => {
    const next = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, isStreaming: true },
      {
        sessionId: SESSION_ID,
        type: 'error',
        data: {
          message: 'tool loop stopped',
          reason: 'tool_use_loop_detected',
          isTerminal: true,
          toolLoop: { kind: 'contract', count: 3 },
        },
      } as Parameters<typeof handleStreamEvent>[1],
    );

    expect(next.toolLoop).toEqual({ kind: 'contract', count: 3 });
  });

  it('preserves tool-loop details when the trailing done event follows the terminal error', () => {
    const afterError = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, isStreaming: true },
      {
        sessionId: SESSION_ID,
        type: 'error',
        data: {
          message: 'tool loop stopped',
          reason: 'tool_use_loop_detected',
          isTerminal: true,
          toolLoop: { kind: 'contract', count: 3 },
        },
      } as Parameters<typeof handleStreamEvent>[1],
    );

    const afterDone = handleStreamEvent(afterError, {
      sessionId: SESSION_ID,
      type: 'done',
      data: {},
    } as Parameters<typeof handleStreamEvent>[1]);

    expect(afterDone.error).toBe('tool loop stopped');
    expect(afterDone.toolLoop).toEqual({ kind: 'contract', count: 3 });
  });

  it('clears stale tool-loop details on a clean done event', () => {
    const next = handleStreamEvent(
      {
        ...EMPTY_SESSION_STATE,
        error: null,
        toolLoop: { kind: 'contract', count: 3 },
        isStreaming: true,
      },
      {
        sessionId: SESSION_ID,
        type: 'done',
        data: {},
      } as Parameters<typeof handleStreamEvent>[1],
    );

    expect(next.toolLoop).toBeNull();
  });

  it('rejects malformed tool-loop details before they reach renderer state', () => {
    const next = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, isStreaming: true },
      {
        sessionId: SESSION_ID,
        type: 'error',
        data: {
          message: 'tool loop stopped',
          reason: 'tool_use_loop_detected',
          isTerminal: true,
          toolLoop: { kind: 'missing_required_field', count: 3 },
        },
      } as Parameters<typeof handleStreamEvent>[1],
    );

    expect(next.toolLoop).toBeNull();
  });
});
