import { describe, expect, it, vi } from 'vitest';

import {
  magpieAccountFrom,
  magpieAccountId,
  magpieWindowFrom,
  readMagpieQuotas,
  MAGPIE_QUOTA_MAX_BODY_BYTES,
} from '../quotaReader';

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);
const ORIGIN = 'http://127.0.0.1:3425';

function jsonResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function envelope(data: unknown[]): string {
  return JSON.stringify({ object: 'list', data });
}

describe('readMagpieQuotas', () => {
  it('rejects a non-loopback origin without fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(
      readMagpieQuotas('magpie', 'https://api.example.com', { fetchImpl: fetchImpl as never, nowMs: NOW }),
    ).rejects.toThrow(/loopback/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends no Authorization header and accepts JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])));
    await readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe(`${ORIGIN}/v1/magpie/quotas`);
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it('treats a 404 as "not Magpie"', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('nope', { status: 404 }));
    const read = await readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW });
    expect(read).toEqual({ notMagpie: true, accounts: [] });
  });

  it('treats malformed JSON and a non-list envelope as "not Magpie"', async () => {
    const badJson = vi.fn(async () => jsonResponse('<html>not json</html>'));
    expect((await readMagpieQuotas('magpie', ORIGIN, { fetchImpl: badJson as never, nowMs: NOW })).notMagpie).toBe(true);
    const badShape = vi.fn(async () => jsonResponse(JSON.stringify({ object: 'other', data: [] })));
    expect((await readMagpieQuotas('magpie', ORIGIN, { fetchImpl: badShape as never, nowMs: NOW })).notMagpie).toBe(true);
  });

  it('throws on a non-2xx, non-404 status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('', { status: 503 }));
    await expect(readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW }))
      .rejects.toThrow(/status 503/);
  });

  it('throws on an oversized body', async () => {
    const big = envelope([{ provider: 'x', windows: [] }]).padEnd(MAGPIE_QUOTA_MAX_BODY_BYTES + 100, ' ');
    const fetchImpl = vi.fn(async () => jsonResponse(big));
    await expect(
      readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW, maxBodyBytes: 64 }),
    ).rejects.toThrow(/too large/);
  });

  it('keeps every account in a response within the byte budget', async () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ provider: 'x', name: `a${i}`, windows: [] }));
    const fetchImpl = vi.fn(async () => jsonResponse(envelope(many)));
    const read = await readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW });
    expect(read.accounts).toHaveLength(65);
    expect(read.accounts.at(-1)?.name).toBe('a64');
  });

  it('maps a quota envelope and never surfaces the upstream error text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        envelope([
          {
            provider: 'claude',
            name: 'Team',
            user: 'someone@example.com',
            plan: 'max',
            asOf: new Date(NOW - 60_000).toISOString(),
            windows: [
              { name: '5 hours', remaining: 40, resetsAt: new Date(NOW + 3_600_000).toISOString() },
              { name: 'Credits', remaining: 10, display: '318.78 / 500', unlimited: false },
            ],
          },
          { provider: 'qwenwork', user: 'x@y.z', error: 'signed out at x@y.z', windows: [] },
        ]),
      ),
    );
    const read = await readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW });
    expect(read.notMagpie).toBe(false);
    expect(read.accounts).toHaveLength(2);
    const [first, second] = read.accounts;
    expect(first).toMatchObject({ providerId: 'magpie', provider: 'claude', name: 'Team', plan: 'max', status: 'ok' });
    expect(first.observedAtMs).toBe(NOW - 60_000);
    expect(second.status).toBe('needs-sign-in');
    expect(second.windows).toEqual([]);
    // The upstream error string (embedding an email) must not travel onward anywhere.
    expect(JSON.stringify(read.accounts)).not.toContain('signed out');
    expect(JSON.stringify(read.accounts)).not.toContain('x@y.z');
    expect(JSON.stringify(read.accounts)).not.toContain('someone@example.com');
  });

  it('does not expose transport details when a response stream fails', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('upstream private response detail'));
      },
    }));
    await expect(readMagpieQuotas('magpie', ORIGIN, {
      fetchImpl: vi.fn(async () => response) as never,
      nowMs: NOW,
    })).rejects.toThrow('magpie quota response unavailable');
  });

  it('throws a generic message when the gateway is unreachable, leaking no upstream detail', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED to 127.0.0.1:3425 with token abc');
    });
    await expect(readMagpieQuotas('magpie', ORIGIN, { fetchImpl: fetchImpl as never, nowMs: NOW }))
      .rejects.toThrow('magpie quota gateway unreachable');
  });
});

describe('magpieAccountId', () => {
  it('is stable across field reorders and distinguishes same-provider accounts', () => {
    const a1 = magpieAccountId('magpie', { provider: 'claude', user: 'a@x.com', alias: '', name: 'n', from: '' });
    const a2 = magpieAccountId('magpie', { from: '', name: 'n', alias: '', user: 'a@x.com', provider: 'claude' });
    const b = magpieAccountId('magpie', { provider: 'claude', user: 'b@x.com', alias: '', name: 'n', from: '' });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.startsWith('magpie:magpie:')).toBe(true);
    expect(a1).not.toContain('a@x.com');
  });
});

describe('magpieWindowFrom', () => {
  it('maps "N hours" to a session window and "N days" to a weekly one', () => {
    const session = magpieWindowFrom({ name: '5 hours', remaining: 30, resetsAt: new Date(NOW + 3_600_000).toISOString() }, NOW);
    expect(session).toMatchObject({ kind: 'session', windowMinutes: 300, usedPercent: 70 });
    const week = magpieWindowFrom({ name: '7 days', remaining: 50 }, NOW);
    expect(week).toMatchObject({ kind: 'week', windowMinutes: 10_080, usedPercent: 50 });
  });

  it('keeps an unrecognized name verbatim as a named window', () => {
    const named = magpieWindowFrom({ name: 'Credits', remaining: 10, display: '318.78 / 500' }, NOW);
    expect(named).toMatchObject({ kind: 'named', label: 'Credits', display: '318.78 / 500', windowMinutes: 0 });
  });

  it('marks a pool window scoped', () => {
    const scoped = magpieWindowFrom({ name: 'Fable', remaining: 20, pool: true }, NOW);
    expect(scoped).toMatchObject({ kind: 'scoped', label: 'Fable' });
  });

  it('reads unlimited as 0 used and drops a reset already in the past', () => {
    expect(magpieWindowFrom({ name: 'Plan', unlimited: true, used: 99 }, NOW)).toMatchObject({ usedPercent: 0 });
    const past = magpieWindowFrom({ name: '5 hours', remaining: 30, resetsAt: new Date(NOW - 1000).toISOString() }, NOW);
    expect(past!.resetsAtMs).toBeNull();
  });

  it('derives used from remaining, falling back to used, clamped', () => {
    expect(magpieWindowFrom({ name: 'x', remaining: 100 }, NOW)!.usedPercent).toBe(0);
    expect(magpieWindowFrom({ name: 'x', used: 120 }, NOW)!.usedPercent).toBe(100);
    expect(magpieWindowFrom({ name: 'x' }, NOW)).toBeNull();
  });
});

describe('magpieAccountFrom', () => {
  it('marks an account with a balance but no windows as no-windows and keeps the balance text', () => {
    const account = magpieAccountFrom('magpie', { provider: 'anthropic', name: 'n', balance: '12.50', until: 'soon', windows: [] }, NOW);
    expect(account).toMatchObject({ status: 'no-windows', balanceText: '12.50', windows: [] });
  });

  it('never falls back to the upstream email for the display name', () => {
    const account = magpieAccountFrom('magpie', { provider: 'claude', user: 'a@x.com', name: '', alias: '', windows: [] }, NOW);
    expect(account.name).not.toContain('@');
    expect(account.name).toBe('claude');
  });

  it('takes observedAtMs as the later of asOf and readAt', () => {
    const account = magpieAccountFrom(
      'magpie',
      { provider: 'p', name: 'n', asOf: new Date(NOW - 5000).toISOString(), readAt: new Date(NOW).toISOString(), windows: [] },
      NOW,
    );
    expect(account.observedAtMs).toBe(NOW);
  });
});
