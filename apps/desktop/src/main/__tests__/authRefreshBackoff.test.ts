import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { AuthRefreshBackoff } from '../authRefreshBackoff';

// Execute the production admission path with a controlled in-flight network result.
// This reproduces a relay recovery signal arriving before the old refresh fails,
// without importing Electron or accessing real credentials.
const source = ts.createSourceFile(
  'authManager.ts',
  readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'refresh',
)!;
const compiled = ts.transpileModule(
  declaration
    .getText(source)
    .replace('export async function refresh(', 'async function refreshUnderTest('),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function recoveryHarness() {
  const retry = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const h = new Function(
    'AuthRefreshBackoff',
    'refresh',
    `
    let refreshPromise = null;
    const coldStartAuthInFlight = null;
    let authStateEpoch = 1;
    const refreshBackoff = new AuthRefreshBackoff(() => 1_000_000, () => 0);
    const getActiveAppSession = () => ({ mode: 'cloud' });
    const log = { debug() {} };
    ${compiled}
    return { call: refreshUnderTest, backoff: refreshBackoff,
      setPending(value) { refreshPromise = value; },
      setEpoch(value) { authStateEpoch = value; } };
  `,
  )(AuthRefreshBackoff, retry);
  let finish!: (value: boolean) => void;
  h.setPending(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  return {
    ...h,
    retry,
    finish: (value = false) => {
      h.setPending(null);
      finish(value);
    },
  };
}

describe('network recovery during an in-flight refresh', () => {
  it('shares a late network failure without launching a synchronized recovery request', async () => {
    const h = recoveryHarness();
    const ordinary = h.call();
    const first = h.call({ networkRecovered: true });
    const second = h.call({ networkRecovered: true });
    h.backoff.defer(1);
    h.finish();
    await expect(Promise.all([ordinary, first, second])).resolves.toEqual([false, false, false]);
    expect(h.retry).not.toHaveBeenCalled();
    expect(h.backoff.remaining(1)).toBe(60_000);
  });

  it('does not bypass or reset backoff when recovery hints arrive after failure', async () => {
    const h = recoveryHarness();
    h.finish();
    h.backoff.defer(1);
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(h.call({ networkRecovered: true })).resolves.toBe(false);
    }
    expect(h.retry).not.toHaveBeenCalled();
    expect(h.backoff.remaining(1)).toBe(60_000);
    expect(h.backoff.defer(1)).toBe(120_000);
  });

  it.each(['server failure', 'Retry-After', 'owner changed', 'succeeded'])(
    'does not retry or clear the deadline when the in-flight refresh %s',
    async (outcome) => {
      const h = recoveryHarness();
      const recovery = h.call({ networkRecovered: true });
      const epoch = outcome === 'owner changed' ? 2 : 1;
      h.setEpoch(epoch);
      const delay = h.backoff.defer(epoch, outcome === 'Retry-After' ? 1_120_000 : undefined);
      h.finish(outcome === 'succeeded');
      await expect(recovery).resolves.toBe(outcome === 'succeeded');
      expect(h.retry).not.toHaveBeenCalled();
      expect(h.backoff.remaining(epoch)).toBe(delay);
    },
  );
});

describe('runtime auth refresh backoff', () => {
  // 2026-10-29: a fleet-wide outage must not synchronize all clients on a
  // fixed retry interval or on the same Retry-After deadline (unit, fake time).
  it('spreads clients across the retry window, including after a common server deadline', () => {
    const clients = [0, 0.25, 0.5, 0.75, 0.999].map(
      (random) =>
        new AuthRefreshBackoff(
          () => 1_000_000,
          () => random,
        ),
    );
    const delays = clients.map((client) => client.defer(1, 1_600_000));
    expect(new Set(delays).size).toBe(clients.length);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(600_000);
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(50_000);
  });

  it('backs off repeated failures, stays capped, and resets only for a new login or success', () => {
    const backoff = new AuthRefreshBackoff(
      () => 1_000_000,
      () => 0.5,
    );
    const delays = Array.from({ length: 8 }, () => backoff.defer(1));
    expect(delays.slice(0, 4)).toEqual([90_000, 180_000, 360_000, 450_000]);
    expect(delays.slice(4)).toEqual([450_000, 450_000, 450_000, 450_000]);
    expect(backoff.defer(2)).toBe(90_000);
    backoff.clear();
    expect(backoff.defer(2)).toBe(90_000);
  });

  it('continues to randomize retries after reaching the cap', () => {
    let fraction = 0;
    const backoff = new AuthRefreshBackoff(
      () => 1_000_000,
      () => fraction,
    );
    for (let attempt = 0; attempt < 4; attempt++) backoff.defer(1);
    expect(backoff.defer(1)).toBe(300_000);
    fraction = 0.999;
    expect(backoff.defer(1)).toBe(599_700);
  });

  it('keeps an absolute deadline across two-second explicit calls and resumes at expiry', () => {
    let now = 1_000_000;
    const backoff = new AuthRefreshBackoff(
      () => now,
      () => 0,
    );
    expect(backoff.remaining(1)).toBe(0);
    expect(backoff.defer(1)).toBe(60_000);
    for (let elapsed = 2_000; elapsed < 60_000; elapsed += 2_000) {
      now = 1_000_000 + elapsed;
      expect(backoff.remaining(1)).toBe(60_000 - elapsed);
    }
    now = 1_060_000;
    expect(backoff.remaining(1)).toBe(0);
  });

  it('honors a longer server wait without applying the failed login generation to another account', () => {
    let now = 1_000_000;
    const backoff = new AuthRefreshBackoff(
      () => now,
      () => 0,
    );
    expect(backoff.defer(1, now + 120_000)).toBe(120_000);
    now += 60_000;
    expect(backoff.remaining(1)).toBe(60_000);
    expect(backoff.remaining(2)).toBe(0);
    backoff.defer(2);
    expect(backoff.remaining(1)).toBe(0);
    expect(backoff.remaining(2)).toBe(60_000);
  });

  it.each([undefined, 0, 999_999, Number.NaN, Number.POSITIVE_INFINITY])(
    'retains the minimum wait for invalid or shorter deadline %s',
    (retryAt) => {
      const backoff = new AuthRefreshBackoff(
        () => 1_000_000,
        () => 0,
      );
      expect(backoff.defer(1, retryAt)).toBe(60_000);
    },
  );

  it('clears the failed wait when a successful login or refresh schedules normal renewal', () => {
    const backoff = new AuthRefreshBackoff(
      () => 1_000_000,
      () => 0,
    );
    backoff.defer(1);
    backoff.clear();
    expect(backoff.remaining(1)).toBe(0);
  });
});
