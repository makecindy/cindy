// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_COOLDOWN_MS,
  clearFallbackCooldown,
  fallbackCooldownFor,
  markFallbackExhausted,
  __resetForTest,
  __STORAGE_KEY,
} from '../fallbackCooldowns';

const uid = 'openai::gpt-6-astra::codex::high';

beforeEach(() => {
  __resetForTest();
  window.localStorage.clear();
});

describe('fallbackCooldowns', () => {
  it('records an exact reset time from upstream', () => {
    const now = 1_000_000;
    const reset = now + 24 * 60 * 60 * 1000;
    markFallbackExhausted(uid, reset, now);

    const cooldown = fallbackCooldownFor(uid, now);
    expect(cooldown?.until).toBe(reset);
    expect(cooldown?.exact, 'upstream gave a real time').toBe(true);
  });

  /** No reset time: estimate, but never claim it is exact. */
  it('falls back to a conservative window when upstream gives no time', () => {
    const now = 1_000_000;
    markFallbackExhausted(uid, null, now);

    const cooldown = fallbackCooldownFor(uid, now);
    expect(cooldown?.until).toBe(now + DEFAULT_COOLDOWN_MS);
    expect(cooldown?.exact, 'a guess must not be shown as a known time').toBe(false);
  });

  /** A reset time already in the past is useless; treat it as no time at all. */
  it('ignores a reset time that has already passed', () => {
    const now = 1_000_000;
    markFallbackExhausted(uid, now - 5_000, now);
    expect(fallbackCooldownFor(uid, now)?.exact).toBe(false);
  });

  it('expires by the clock, with no sweeper', () => {
    const now = 1_000_000;
    const reset = now + 60_000;
    markFallbackExhausted(uid, reset, now);

    expect(fallbackCooldownFor(uid, reset - 1)).not.toBeNull();
    expect(fallbackCooldownFor(uid, reset + 1), 'past the reset it is usable again').toBeNull();
  });

  /** A successful run is harder evidence than any timestamp. */
  it('clears on success', () => {
    const now = 1_000_000;
    markFallbackExhausted(uid, now + 60_000, now);
    clearFallbackCooldown(uid);
    expect(fallbackCooldownFor(uid, now)).toBeNull();
  });

  /**
   * The cooldown is worthless if it dies with the window: the whole point is
   * that tomorrow's new chat still knows this model was dry.
   */
  it('persists to storage so it survives a reload', () => {
    const now = 1_000_000;
    const reset = now + 60_000;
    markFallbackExhausted(uid, reset, now);

    const raw = window.localStorage.getItem(__STORAGE_KEY);
    expect(raw, 'must be written to storage, not just memory').toBeTruthy();
    expect(JSON.parse(raw as string)[uid]).toMatchObject({ until: reset, exact: true });
  });

  it('keeps entries independent', () => {
    const now = 1_000_000;
    markFallbackExhausted(uid, now + 60_000, now);
    expect(fallbackCooldownFor('anthropic::claude-opus-5::claude-code::', now)).toBeNull();
  });
});
