import { describe, expect, it } from 'vitest';

import {
  classifyFallbackFailure,
  decideFallbackStep,
  fallbackEntryUid,
  initialFallbackChainState,
  isFallbackChainActive,
  normalizeFallbackChain,
  type FallbackChain,
  type FallbackChainEntry,
} from '../fallbackChain.js';

const main: FallbackChainEntry = {
  uid: 'a',
  providerId: 'openai',
  modelId: 'gpt-5',
  agent: 'codex',
};
const backup: FallbackChainEntry = {
  uid: 'b',
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  agent: 'claude-code',
};
const third: FallbackChainEntry = {
  uid: 'c',
  providerId: 'chatgpt-web-default',
  modelId: 'chatgpt-web/high',
  agent: 'codex',
};

const chain = (...entries: FallbackChainEntry[]): FallbackChain => ({ entries, enabled: true });

describe('classifyFallbackFailure', () => {
  it('treats plan/account exhaustion as unrecoverable by retry', () => {
    expect(classifyFallbackFailure({ message: 'x', tag: 'usageLimitExceeded' })).toBe('usageExhausted');
    expect(classifyFallbackFailure({ message: 'x', tag: 'sessionBudgetExceeded' })).toBe('usageExhausted');
    expect(classifyFallbackFailure({ message: 'You have exceeded your quota' })).toBe('usageExhausted');
  });

  it('prefers quota text over a co-reported 429', () => {
    // A weekly bucket that is empty still answers 429. Retrying cannot refill it.
    expect(classifyFallbackFailure({ message: 'usage limit reached', status: 429 })).toBe(
      'usageExhausted',
    );
  });

  it('treats bare rate limiting and overload as transient', () => {
    expect(classifyFallbackFailure({ message: 'Too Many Requests', status: 429 })).toBe('transient');
    expect(classifyFallbackFailure({ message: 'overloaded', status: 529 })).toBe('transient');
  });

  it('treats auth and request-shape errors as fatal', () => {
    expect(classifyFallbackFailure({ message: 'unauthorized', status: 401 })).toBe('fatal');
    expect(classifyFallbackFailure({ message: 'bad request', status: 400 })).toBe('fatal');
    expect(classifyFallbackFailure({ message: 'too long', tag: 'context_length_exceeded' })).toBe(
      'fatal',
    );
  });
});

describe('decideFallbackStep', () => {
  it('retries a transient failure exactly once, then advances', () => {
    const c = chain(main, backup);
    const first = decideFallbackStep(c, initialFallbackChainState(), {
      message: 'Too Many Requests',
      status: 429,
    });
    expect(first).toMatchObject({ action: 'retry', entry: main });

    const second = decideFallbackStep(c, { index: 0, retries: 1 }, {
      message: 'Too Many Requests',
      status: 429,
    });
    expect(second).toMatchObject({ action: 'advance', entry: backup, from: main });
  });

  it('does not retry on usage exhaustion; goes straight to the fallback', () => {
    const decision = decideFallbackStep(chain(main, backup), initialFallbackChainState(), {
      message: 'weekly limit reached',
      tag: 'usageLimitExceeded',
    });
    expect(decision).toMatchObject({ action: 'advance', entry: backup });
  });

  it('stops on a fatal failure instead of walking the whole chain', () => {
    const decision = decideFallbackStep(chain(main, backup, third), initialFallbackChainState(), {
      message: 'invalid api key',
      status: 401,
    });
    expect(decision).toEqual({ action: 'stop', reason: 'fatal' });
  });

  it('stops once the last entry is exhausted', () => {
    const decision = decideFallbackStep(chain(main, backup), { index: 1, retries: 1 }, {
      message: 'Too Many Requests',
      status: 429,
    });
    expect(decision).toEqual({ action: 'stop', reason: 'chain-exhausted' });
  });

  it('walks a long chain one entry at a time', () => {
    const c = chain(main, backup, third);
    const step1 = decideFallbackStep(c, { index: 0, retries: 1 }, { message: 'q', tag: 'usageLimitExceeded' });
    expect(step1).toMatchObject({ action: 'advance', entry: backup });
    const step2 = decideFallbackStep(c, { index: 1, retries: 1 }, { message: 'q', tag: 'usageLimitExceeded' });
    expect(step2).toMatchObject({ action: 'advance', entry: third });
  });
});

describe('chain shape', () => {
  it('is inactive when disabled or when only a main model is set', () => {
    expect(isFallbackChainActive({ entries: [main], enabled: true })).toBe(false);
    expect(isFallbackChainActive({ entries: [main, backup], enabled: false })).toBe(false);
    expect(isFallbackChainActive({ entries: [main, backup], enabled: true })).toBe(true);
    expect(isFallbackChainActive(null)).toBe(false);
  });

  it('drops duplicate targets rather than rejecting the chain', () => {
    const duplicate = { ...backup, uid: 'other' };
    const result = normalizeFallbackChain(chain(main, backup, duplicate));
    expect(result.entries).toHaveLength(2);
  });

  it('treats the same model at different efforts as different targets', () => {
    // The picker lists one model at several thinking levels; "Opus high then
    // Opus low" is a real chain, not a duplicate.
    const high = fallbackEntryUid({ providerId: 'p', modelId: 'm', agent: 'codex', effort: 'high' });
    const low = fallbackEntryUid({ providerId: 'p', modelId: 'm', agent: 'codex', effort: 'low' });
    expect(high).not.toBe(low);
  });

  it('treats the same model under two accounts as different targets', () => {
    // Two OpenAI logins are the entire point of a fallback; they must not collapse.
    expect(fallbackEntryUid({ providerId: 'openai-a', modelId: 'm', agent: 'codex' })).not.toBe(
      fallbackEntryUid({ providerId: 'openai-b', modelId: 'm', agent: 'codex' }),
    );
  });

  it('canonicalizes legacy cc engine ids and recomputes their uids', () => {
    const result = normalizeFallbackChain(
      chain(
        { ...main, agent: 'cc', uid: 'legacy-main' },
        { ...backup, agent: 'cc', uid: 'legacy-backup' },
      ),
    );

    expect(result.entries.map(({ agent, uid }) => ({ agent, uid }))).toEqual([
      { agent: 'claude-code', uid: 'openai::gpt-5::claude-code::' },
      { agent: 'claude-code', uid: 'anthropic::claude-sonnet::claude-code::' },
    ]);
  });
});
