import { describe, expect, it } from 'vitest';

import {
  isTerminalAgentErrorEvent,
  isTerminalTurnEvent,
  isTurnWatchdogLivenessEvent,
  type AgentEvent,
} from './events.js';

describe('AgentEvent terminal predicates', () => {
  it('uses one shared fallback rule for agent error terminal state', () => {
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'done', isTerminal: true } })).toBe(true);
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'retry', isTerminal: false } })).toBe(false);
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'retry', willRetry: true } })).toBe(false);
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'legacy' } })).toBe(true);
  });

  it('classifies full turn terminal events from the same shared helper', () => {
    const terminalError: AgentEvent = { type: 'error', data: { message: 'done', isTerminal: true } };
    const retryableError: AgentEvent = { type: 'error', data: { message: 'retry', willRetry: true } };

    expect(isTerminalTurnEvent({ type: 'done', data: {} })).toBe(true);
    expect(isTerminalTurnEvent({ type: 'status', data: { isRunning: false } })).toBe(true);
    expect(isTerminalTurnEvent(terminalError)).toBe(true);
    expect(isTerminalTurnEvent(retryableError)).toBe(false);
    expect(isTerminalTurnEvent({ type: 'text', data: { text: 'still running' } })).toBe(false);
  });
});

describe('isTurnWatchdogLivenessEvent', () => {
  it('excludes transport heartbeats and background work', () => {
    expect(isTurnWatchdogLivenessEvent({ type: 'status', data: { isRunning: true } })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'status', data: { isRunning: false } })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'account_usage', data: {} })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({
      type: 'text',
      data: { text: 'hi' },
      turnScope: 'background',
    })).toBe(false);
  });

  it('counts product activity as liveness', () => {
    expect(isTurnWatchdogLivenessEvent({ type: 'text', data: { text: 'hi' } })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'thinking', data: {} })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'tool_use', data: {} })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'tool_result', data: {} })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'tool_result_full', data: {} })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'agent_task_update', data: {} })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'image', data: {} })).toBe(true);
    expect(isTurnWatchdogLivenessEvent({ type: 'interaction_request', data: {} })).toBe(true);
  });

  it('excludes terminals, diagnostics, and retryable errors', () => {
    expect(isTurnWatchdogLivenessEvent({ type: 'done', data: {} })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'error', data: { isTerminal: true } })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({
      type: 'error',
      data: { message: 'retry', willRetry: true, isTerminal: false },
    })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'turn_diff', data: {} })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'interaction_dismissed', data: {} })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'plan_mode_changed', data: {} })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'compact_boundary', data: {} })).toBe(false);
    expect(isTurnWatchdogLivenessEvent({ type: 'session_id', data: {} })).toBe(false);
  });
});
