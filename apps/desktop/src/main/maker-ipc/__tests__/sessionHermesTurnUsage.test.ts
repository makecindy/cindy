import type { AgentEvent, Session } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  recordTurnUsageOnMessage: vi.fn(
    async (_args: {
      sessionId: string;
      clientId: string;
      turnUsageDetails: { provider?: string; model?: string };
    }) => true,
  ),
  recordSessionTurnTokens: vi.fn(async (_sessionId: string, _tokenDelta: number) => {}),
}));

vi.mock('../../sessionSpendBroadcaster.js', () => ({
  recordSessionTurnTokens: effects.recordSessionTurnTokens,
}));
vi.mock('../../turnCostBroadcaster.js', () => ({
  recordTurnUsageOnMessage: effects.recordTurnUsageOnMessage,
}));

import { recordSessionHermesTurnUsage } from '../sessionHermesTurnUsage.js';

const session = { id: 'session-1' } as unknown as Session;

function hermesDone(usage: unknown): AgentEvent {
  return {
    type: 'done',
    source: 'hermes',
    data: { type: 'hermes/turn-complete', usage },
  } as unknown as AgentEvent;
}

describe('recordSessionHermesTurnUsage', () => {
  beforeEach(() => {
    effects.recordTurnUsageOnMessage.mockClear();
    effects.recordSessionTurnTokens.mockClear();
  });

  it('stores the turn tokens, the model the CLI ran and the route provider', async () => {
    recordSessionHermesTurnUsage(
      { readHermesRoute: async () => ({ model: 'deepseek-flash', provider: 'deepseek' }) },
      session,
      hermesDone({
        inputTokens: 10149,
        outputTokens: 43,
        cacheReadTokens: 6784,
        cacheCreationTokens: 0,
        durationMs: 7723,
        model: 'deepseek-flash',
      }),
      'assistant-1',
    );

    await vi.waitFor(() => expect(effects.recordTurnUsageOnMessage).toHaveBeenCalledTimes(1));
    expect(effects.recordSessionTurnTokens).toHaveBeenCalledWith('session-1', 10149 + 43 + 6784);
    expect(effects.recordTurnUsageOnMessage).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientId: 'assistant-1',
      turnUsageDetails: expect.objectContaining({
        inputTokens: 10149,
        outputTokens: 43,
        cacheReadTokens: 6784,
        cacheCreateTokens: 0,
        totalTokens: 16976,
        model: 'deepseek-flash',
        provider: 'deepseek',
        durationMs: 7723,
      }),
    });
  });

  it('prefers the model the CLI reported over the home default', async () => {
    recordSessionHermesTurnUsage(
      { readHermesRoute: async () => ({ model: 'deepseek-flash', provider: 'deepseek' }) },
      session,
      hermesDone({ inputTokens: 10, outputTokens: 2, model: 'deepseek-v4-pro' }),
      'assistant-1',
    );

    await vi.waitFor(() => expect(effects.recordTurnUsageOnMessage).toHaveBeenCalledTimes(1));
    expect(effects.recordTurnUsageOnMessage.mock.calls[0]?.[0]).toMatchObject({
      turnUsageDetails: expect.objectContaining({ model: 'deepseek-v4-pro' }),
    });
  });

  it('falls back to the home default model when the CLI reported none', async () => {
    recordSessionHermesTurnUsage(
      { readHermesRoute: async () => ({ model: 'deepseek-flash', provider: 'deepseek' }) },
      session,
      hermesDone({ inputTokens: 10, outputTokens: 2 }),
      'assistant-1',
    );

    await vi.waitFor(() => expect(effects.recordTurnUsageOnMessage).toHaveBeenCalledTimes(1));
    expect(effects.recordTurnUsageOnMessage.mock.calls[0]?.[0]).toMatchObject({
      turnUsageDetails: expect.objectContaining({ model: 'deepseek-flash', provider: 'deepseek' }),
    });
  });

  it('keeps the tokens when the route cannot be read', async () => {
    recordSessionHermesTurnUsage(
      {
        readHermesRoute: async () => {
          throw new Error('home unreadable');
        },
      },
      session,
      hermesDone({ inputTokens: 10, outputTokens: 2, model: 'deepseek-flash' }),
      'assistant-1',
    );

    await vi.waitFor(() => expect(effects.recordTurnUsageOnMessage).toHaveBeenCalledTimes(1));
    expect(effects.recordTurnUsageOnMessage.mock.calls[0]?.[0]).toMatchObject({
      turnUsageDetails: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 2,
        model: 'deepseek-flash',
      }),
    });
    // No provider = no price, but the tokens are still a fact.
    expect(
      (effects.recordTurnUsageOnMessage.mock.calls[0]?.[0] as {
        turnUsageDetails: { provider?: string };
      }).turnUsageDetails.provider,
    ).toBeUndefined();
  });

  it('ignores turns of other agents and turns without usage', () => {
    recordSessionHermesTurnUsage(
      { readHermesRoute: async () => ({ provider: 'deepseek' }) },
      session,
      { type: 'done', source: 'codex', data: { usage: { inputTokens: 5 } } } as unknown as AgentEvent,
      'assistant-1',
    );
    recordSessionHermesTurnUsage(
      { readHermesRoute: async () => ({ provider: 'deepseek' }) },
      session,
      hermesDone({ inputTokens: 0, outputTokens: 0 }),
      'assistant-1',
    );
    expect(effects.recordTurnUsageOnMessage).not.toHaveBeenCalled();
    expect(effects.recordSessionTurnTokens).not.toHaveBeenCalled();
  });
});
