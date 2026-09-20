import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Session, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { isHeadlessTerminalEvent } from './host.js';

describe('Headless observer with the real Session event lifecycle', () => {
  it.each(['claude-code', 'codex'] as const)('waits for %s continuation and then accepts a result-only next turn', async (agentKind) => {
    const pending: Array<AgentEvent | null> = [];
    let waiter: ((event: AgentEvent | null) => void) | undefined;
    let running = false;
    const claims = new Map<number, 'awaiting' | 'active' | 'cancelled'>();
    const deliver = (event: AgentEvent | null) => {
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(event); }
      else pending.push(event);
    };
    const handle = {
      id: 'headless-test-thread', agentKind, model: 'fixture-model',
      async send() { if (running) throw new Error('SESSION_RUNNING'); running = true; },
      async steer() {}, async abort() { running = false; },
      async close() { running = false; deliver(null); },
      async *events() {
        for (;;) {
          const event = pending.length ? pending.shift()! : await new Promise<AgentEvent | null>((resolve) => { waiter = resolve; });
          if (event === null) return;
          yield event;
        }
      },
      isTurnRunning: () => running,
      setInteractionResolver() {},
      beginTurnContinuationWait: (id?: number) => id === undefined ? null : claims.get(id) ?? null,
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    } as unknown as AgentSessionHandle;
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    const session = new Session({ id: 'headless-test-session', agentKind, workDir: path.resolve('fixture-repo'), handle, capabilities: {} as never, logger });
    const seen: AgentEvent[] = [];
    const terminals: AgentEvent[] = [];
    let attempt = 1;
    session.onEvent((event) => {
      seen.push(event);
      if (isHeadlessTerminalEvent(event, session, attempt)) terminals.push(event);
    });
    const emit = async (event: AgentEvent, keepRunning = true) => {
      if (!keepRunning) running = false;
      const count = seen.length;
      deliver(event);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(count));
    };
    try {
      expect(await session.send('first', { turnAttemptToken: attempt })).toEqual({ accepted: true });
      claims.set(7, 'awaiting');
      await emit({ type: 'done', data: {}, turnContinuationId: 7 });
      await emit({ type: 'status', data: { isRunning: false } });
      expect(terminals).toHaveLength(0);
      await emit({ type: 'text', data: { text: 'continuation output', isFinal: true } });
      claims.set(7, 'active');
      await emit({ type: 'done', data: {} }, false);
      expect(terminals).toHaveLength(1);
      expect(seen.some((event) => event.type === 'text' && event.turnAttemptToken === 1)).toBe(true);
      attempt = 2;
      await emit({ type: 'status', data: { isRunning: false } }, false);
      expect(terminals).toHaveLength(1);
      expect(await session.send('second', { turnAttemptToken: attempt })).toEqual({ accepted: true });
      await emit({ type: 'done', data: {} }, false);
      expect(terminals.map((event) => event.turnAttemptToken)).toEqual([1, 2]);
    } finally { await session.close(); }
  });
});
