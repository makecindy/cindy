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
    let authStateEpoch = 1;
    const refreshBackoff = new AuthRefreshBackoff(() => 1_000_000);
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
  it('retries a late network failure once and retains the next failure cooldown', async () => {
    const h = recoveryHarness();
    h.retry.mockImplementation(async () => {
      h.backoff.defer(1, undefined, true);
      return false;
    });
    const ordinary = h.call();
    const recovery = h.call({ networkRecovered: true });
    expect(h.retry).not.toHaveBeenCalled();
    h.backoff.defer(1, undefined, true);
    h.finish();
    await expect(ordinary).resolves.toBe(false);
    await expect(recovery).resolves.toBe(false);
    expect(h.retry).toHaveBeenCalledExactlyOnceWith();
    expect(h.backoff.remaining(1)).toBe(60_000);
  });

  it('coalesces concurrent recovery callers onto the new in-flight refresh', async () => {
    const h = recoveryHarness();
    let completeRetry!: (value: boolean) => void;
    const next = new Promise<boolean>((resolve) => {
      completeRetry = resolve;
    });
    h.retry.mockImplementation(() => {
      h.setPending(next);
      return next;
    });
    const first = h.call({ networkRecovered: true });
    const second = h.call({ networkRecovered: true });
    h.backoff.defer(1, undefined, true);
    h.finish();
    await Promise.resolve();
    expect(h.retry).toHaveBeenCalledExactlyOnceWith();
    completeRetry(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it.each(['server failure', 'Retry-After', 'owner changed', 'succeeded'])(
    'does not retry or clear the deadline when the in-flight refresh %s',
    async (outcome) => {
      const h = recoveryHarness();
      const recovery = h.call({ networkRecovered: true });
      const epoch = outcome === 'owner changed' ? 2 : 1;
      h.setEpoch(epoch);
      const delay = h.backoff.defer(
        epoch,
        outcome === 'Retry-After' ? 1_120_000 : undefined,
        outcome === 'owner changed',
      );
      h.finish(outcome === 'succeeded');
      await expect(recovery).resolves.toBe(outcome === 'succeeded');
      expect(h.retry).not.toHaveBeenCalled();
      expect(h.backoff.remaining(epoch)).toBe(delay);
    },
  );
});

describe('runtime auth refresh backoff', () => {
  it('releases only a transport failure after a real response from the same login generation', () => {
    const backoff = new AuthRefreshBackoff(() => 1_000_000);
    backoff.defer(1, undefined, true);
    backoff.networkRecovered(2);
    expect(backoff.remaining(1)).toBe(60_000);
    backoff.networkRecovered(1);
    expect(backoff.remaining(1)).toBe(0);
    backoff.defer(1);
    backoff.networkRecovered(1);
    expect(backoff.remaining(1)).toBe(60_000);
  });

  it.each([undefined, 1_030_000, 1_120_000])(
    'never bypasses server failure or rate limiting (%s)',
    (retryAt) => {
      const backoff = new AuthRefreshBackoff(() => 1_000_000);
      const delay = backoff.defer(1, retryAt);
      backoff.networkRecovered(1);
      expect(backoff.remaining(1)).toBe(delay);
    },
  );

  it('keeps an absolute deadline across two-second explicit calls and resumes at expiry', () => {
    let now = 1_000_000;
    const backoff = new AuthRefreshBackoff(() => now);
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
    const backoff = new AuthRefreshBackoff(() => now);
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
      const backoff = new AuthRefreshBackoff(() => 1_000_000);
      expect(backoff.defer(1, retryAt)).toBe(60_000);
    },
  );

  it('clears the failed wait when a successful login or refresh schedules normal renewal', () => {
    const backoff = new AuthRefreshBackoff(() => 1_000_000);
    backoff.defer(1);
    backoff.clear();
    expect(backoff.remaining(1)).toBe(0);
  });
});
