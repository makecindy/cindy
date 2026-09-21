import { describe, expect, it } from 'vitest';

import { fallbackEntryUid, type FallbackChain } from '@cindy/maker-shared/fallback-chain';

import { locateChainPosition, planNextFallbackStep, selectStartEntry } from '../fallbackRunner';

const entry = (providerId: string, modelId: string, agent = 'claude-code') => ({
  providerId,
  modelId,
  agent,
  uid: fallbackEntryUid({ providerId, modelId, agent }),
});

const main = entry('openai', 'gpt-6-astra', 'codex');
const backup = entry('anthropic', 'claude-opus-5');
const third = entry('anthropic', 'claude-sonnet-5');

const chain = (...entries: ReturnType<typeof entry>[]): FallbackChain => ({
  entries,
  enabled: true,
});

describe('planNextFallbackStep', () => {
  it('does nothing when the chain is disabled', () => {
    const plan = planNextFallbackStep({
      chain: { ...chain(main, backup), enabled: false },
      current: main,
      failure: { message: 'overloaded', status: 529 },
      retries: 0,
    });
    expect(plan).toEqual({ kind: 'stop', reason: 'inactive' });
  });

  it('does nothing when only the main model is configured', () => {
    const plan = planNextFallbackStep({
      chain: chain(main),
      current: main,
      failure: { message: 'overloaded', status: 529 },
      retries: 0,
    });
    expect(plan).toEqual({ kind: 'stop', reason: 'inactive' });
  });

  /**
   * The user switched to something off-chain between failures. Continuing down
   * the old chain would yank them off the model they just picked.
   */
  it('does nothing when the running model is not on the chain', () => {
    const plan = planNextFallbackStep({
      chain: chain(main, backup),
      current: entry('xd', 'some-other-model'),
      failure: { message: 'overloaded', status: 529 },
      retries: 0,
    });
    expect(plan).toEqual({ kind: 'stop', reason: 'not-on-chain' });
  });

  it('retries once on a transient failure, then advances', () => {
    const first = planNextFallbackStep({
      chain: chain(main, backup),
      current: main,
      failure: { message: 'overloaded', status: 529 },
      retries: 0,
    });
    expect(first).toMatchObject({ kind: 'retry' });

    const second = planNextFallbackStep({
      chain: chain(main, backup),
      current: main,
      failure: { message: 'overloaded', status: 529 },
      retries: 1,
    });
    expect(second).toMatchObject({ kind: 'switch' });
    expect(second.kind === 'switch' && second.target.modelId).toBe('claude-opus-5');
  });

  /** Lev's rule: a usage limit is not worth a retry, go straight to the fallback. */
  it('advances immediately on a usage limit, with no retry', () => {
    const plan = planNextFallbackStep({
      chain: chain(main, backup),
      current: main,
      failure: { message: 'quota', tag: 'usageLimitExceeded' },
      retries: 0,
    });
    expect(plan).toMatchObject({ kind: 'switch' });
    expect(plan.kind === 'switch' && plan.target.modelId).toBe('claude-opus-5');
  });

  it('walks the whole chain, one entry at a time', () => {
    const c = chain(main, backup, third);
    const step1 = planNextFallbackStep({
      chain: c,
      current: main,
      failure: { message: 'quota', tag: 'usageLimitExceeded' },
      retries: 0,
    });
    expect(step1.kind === 'switch' && step1.target.modelId).toBe('claude-opus-5');

    const step2 = planNextFallbackStep({
      chain: c,
      current: backup,
      failure: { message: 'quota', tag: 'usageLimitExceeded' },
      retries: 0,
    });
    expect(step2.kind === 'switch' && step2.target.modelId).toBe('claude-sonnet-5');

    const step3 = planNextFallbackStep({
      chain: c,
      current: third,
      failure: { message: 'quota', tag: 'usageLimitExceeded' },
      retries: 0,
    });
    expect(step3).toEqual({ kind: 'stop', reason: 'chain-exhausted' });
  });

  /** A bad request is not a capacity problem; burning the chain reaches the same error. */
  it('stops on a fatal failure without touching the chain', () => {
    const plan = planNextFallbackStep({
      chain: chain(main, backup),
      current: main,
      failure: { message: 'bad request', status: 400 },
      retries: 0,
    });
    expect(plan).toEqual({ kind: 'stop', reason: 'fatal' });
  });

  it('locates the running config by identity, not by cursor', () => {
    expect(locateChainPosition(chain(main, backup), backup)).toBe(1);
    expect(locateChainPosition(chain(main, backup), entry('zz', 'nope'))).toBe(-1);
  });

  /** A model we already know is dry must not cost another round-trip. */
  it('skips over an entry that is still cooling down', () => {
    const plan = planNextFallbackStep({
      chain: chain(main, backup, third),
      current: main,
      failure: { message: 'quota', tag: 'usageLimitExceeded' },
      retries: 0,
      isCoolingDown: (e) => e.modelId === 'claude-opus-5',
    });
    expect(plan.kind === 'switch' && plan.target.modelId).toBe('claude-sonnet-5');
  });

  it('stops when every remaining entry is cooling down', () => {
    const plan = planNextFallbackStep({
      chain: chain(main, backup, third),
      current: main,
      failure: { message: 'quota', tag: 'usageLimitExceeded' },
      retries: 0,
      isCoolingDown: () => true,
    });
    expect(plan).toEqual({ kind: 'stop', reason: 'chain-exhausted' });
  });
});

describe('selectStartEntry', () => {
  it('starts on the main model when nothing is cooling down', () => {
    expect(selectStartEntry({ chain: chain(main, backup), isCoolingDown: () => false })).toBeNull();
  });

  /** Lev's case: 1 is out for 24h, so a new chat should open straight on 2. */
  it('skips a cooling main model and starts on the first available entry', () => {
    const start = selectStartEntry({
      chain: chain(main, backup, third),
      isCoolingDown: (e) => e.modelId === 'gpt-6-astra',
    });
    expect(start?.modelId).toBe('claude-opus-5');
  });

  it('skips several cooling entries in order', () => {
    const start = selectStartEntry({
      chain: chain(main, backup, third),
      isCoolingDown: (e) => e.modelId !== 'claude-sonnet-5',
    });
    expect(start?.modelId).toBe('claude-sonnet-5');
  });

  /**
   * Everything is cooling: do not refuse to send. Quota may already be back,
   * and a stale cooldown must never hard-block the user.
   */
  it('falls back to the main model when the whole chain is cooling', () => {
    expect(selectStartEntry({ chain: chain(main, backup), isCoolingDown: () => true })).toBeNull();
  });

  it('does nothing for an inactive chain', () => {
    expect(selectStartEntry({ chain: chain(main), isCoolingDown: () => true })).toBeNull();
    expect(selectStartEntry({ chain: null, isCoolingDown: () => true })).toBeNull();
  });
});
