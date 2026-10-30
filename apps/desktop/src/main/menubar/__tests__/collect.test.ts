import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import {
  kimiSource,
  claudeSource,
  codexSource,
  collectMenubarInputs,
  dayKeysEndingAt,
  distinctRemoteSubscriptions,
  paygSource,
  planLabel,
  type MenubarCollectDeps,
} from '../collect';
import { topModels, type MenubarSubscriptionInput } from '../snapshot';
import type { UsageHistoryPayload, UsageHistoryTask } from '../../usage/usageHistory';

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);
const nowSec = NOW / 1000;

function provider(overrides: Partial<ProviderView> & { id: string }): ProviderView {
  return {
    name: overrides.id,
    connected: true,
    suspended: false,
    removed: false,
    source: 'builtin',
    auth: { method: 'oauth' },
    access: { kind: 'subscription' },
    ...overrides,
  } as unknown as ProviderView;
}

describe('source mapping', () => {
  it('reads the generic Codex bucket and its credits', () => {
    const source = codexSource(
      provider({ id: 'codex-a', openAiAccount: { identity: 'a@example.com' } } as never),
      {
        planType: 'pro',
        appServerBuckets: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: nowSec + 86_400 },
            credits: { hasCredits: true, unlimited: false, balance: '1234.5' },
          },
        },
      } as never,
      NOW,
    );
    expect(source).toMatchObject({
      account: 'a@example.com',
      plan: 'Pro',
      credits: 1234.5,
      windows: [{ kind: 'week', usedPercent: 40, resetsAtMs: (nowSec + 86_400) * 1000 }],
    });
  });

  it('drops a window whose reset already passed', () => {
    const source = codexSource(
      provider({ id: 'openai' }),
      { primary: { usedPercent: 90, windowMinutes: 300, resetsAt: nowSec - 10 } } as never,
      NOW,
    );
    expect(source.windows).toEqual([]);
  });

  it('maps Claude session, week and per-model windows', () => {
    const source = claudeSource(
      provider({ id: 'anthropic' }),
      {
        subscriptionType: 'max',
        fiveHour: { utilization: 10, resetsAt: nowSec + 3600 },
        sevenDay: { utilization: 30, resetsAt: nowSec + 86_400 },
        scoped: [{ modelDisplayName: 'Fable', utilization: 50, resetsAt: nowSec + 86_400 }],
      } as never,
      NOW,
    );
    expect(source.account).toBeNull();
    expect(source.windows.map((w) => [w.kind, w.label ?? null, w.usedPercent])).toEqual([
      ['session', null, 10],
      ['week', null, 30],
      ['scoped', 'Fable', 50],
    ]);
  });

  it('leaves local runtimes and the Cindy gateway out of pay-as-you-go', () => {
    expect(paygSource(provider({ id: 'ollama', auth: { method: 'none' } } as never))).toBeNull();
    expect(paygSource(provider({ id: 'xd', auth: { method: 'apiKey' } } as never))).toBeNull();
    expect(paygSource(provider({ id: 'glm', name: 'GLM', auth: { method: 'apiKey' }, access: { kind: 'api' } } as never))).toMatchObject({
      kind: 'payg',
      billing: 'api',
    });
  });

  it('formats plan labels', () => {
    expect(planLabel('max_20x')).toBe('Max 20x');
    expect(planLabel('SuperGrok Heavy')).toBe('SuperGrok Heavy');
    expect(planLabel('  ')).toBeNull();
  });

  it('lists calendar days across a month boundary', () => {
    expect(dayKeysEndingAt('2026-10-02', 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('collectMenubarInputs', () => {
  function task(sessionId: string, source?: string | null): UsageHistoryTask {
    return {
      taskKey: 'local:' + sessionId,
      deviceId: 'local',
      sessionId,
      title: sessionId,
      model: 'gpt-5.5',
      providerId: null,
      source,
      contextTokens: 0,
      contextWindow: 0,
      lastActiveAt: NOW,
    };
  }

  function usage(tasks: UsageHistoryTask[]): UsageHistoryPayload {
    const money = { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' } as const;
    return {
      todayKey: '2026-10-11',
      modelDaily: [{ day: '2026-10-11', agentKind: 'codex', model: 'gpt-5.5', tokens: 1000, money, apiMoney: money, subscriptionEstimateMoney: money }],
      tasks,
      taskDaily: tasks.map((entry, index) => ({ day: '2026-10-11', taskKey: entry.taskKey, tokens: 100 - index })),
    } as UsageHistoryPayload;
  }

  function deps(overrides: Partial<MenubarCollectDeps> = {}): MenubarCollectDeps {
    return {
      nowMs: NOW,
      listProviders: async () => [
        provider({ id: 'openai', auth: { method: 'oauth', native: 'codex' } } as never),
        provider({ id: 'anthropic' }),
      ],
      readCodex: async () => ({ primary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: nowSec + 86_400 } }) as never,
      readClaude: async () => {
        throw new Error('offline');
      },
      readXai: async () => null,
      readBalance: async () => null,
      readUsage: async () => null,
      activities: () => [],
      sessionRow: async () => null,
      selfDeviceName: 'Mac',
      ...overrides,
    };
  }

  it('keeps the other sources when one reader fails', async () => {
    const errors: string[] = [];
    const collected = await collectMenubarInputs(deps({ onError: (scope) => errors.push(scope) }));
    expect(collected.sources.map((s) => s.id)).toEqual(['openai', 'anthropic']);
    expect(errors).toEqual(['claude:anthropic']);
    const claude = collected.sources[1];
    expect(claude.kind === 'subscription' && claude.windows).toEqual([]);
  });

  it('keeps a Codex account that needs reconnecting as a subscription without numbers', async () => {
    let codexReads = 0;
    const collected = await collectMenubarInputs(
      deps({
        listProviders: async () => [
          provider({
            id: 'codex-b',
            auth: { method: 'oauth', native: 'codex' },
            openAiAccount: { identity: 'b@example.com', reconnectRequired: true },
          } as never),
        ],
        readCodex: async () => {
          codexReads += 1;
          return null;
        },
      }),
    );
    expect(collected.sources).toEqual([
      expect.objectContaining({ kind: 'subscription', id: 'codex-b', account: 'b@example.com', windows: [] }),
    ]);
    expect(codexReads).toBe(0);
  });

  it('puts the Cindy balance first and lists running tasks', async () => {
    const collected = await collectMenubarInputs(
      deps({
        readBalance: async () => ({ available: 5, fullAmount: 10, burnPerDay: 1, observedAtMs: NOW, currency: 'USD', quota: null }),
        activities: () => [{ sessionId: 's1', phase: 'running', startedAtMs: NOW - 60_000, lastActivityAtMs: NOW } as never],
        sessionRow: async () => ({ title: 'Fix the chart', model: 'gpt-6-astra', agentKind: 'codex' }),
      }),
    );
    expect(collected.sources[0]).toMatchObject({ kind: 'balance', id: 'cindy', available: 5 });
    expect(collected.tasks).toEqual([
      expect.objectContaining({ sessionId: 's1', title: 'Fix the chart', harness: 'codex', running: true, startedAtMs: NOW - 60_000 }),
    ]);
    expect(collected.usage.days).toHaveLength(90);
  });

  it.each(['cindy-make', 'cindy-make-merge'])('hides %s usage tasks without changing accounting totals', async (source) => {
    const input = usage([task('hidden', source), task('ordinary', null)]);
    const collected = await collectMenubarInputs(deps({ readUsage: async () => input }));

    expect(collected.tasks.map((entry) => entry.sessionId)).toEqual(['ordinary']);
    expect(collected.tasks[0].tokensToday).toBe(99);
    expect(collected.usage.scopes.local.daily.at(-1)).toEqual({ money: [0, 1, 0], paid: 1, tokens: [0, 1000, 0] });
    expect(input.taskDaily).toHaveLength(2);
    expect(input.tasks).toHaveLength(2);
  });

  it.each(['cindy-make', 'cindy-make-merge'])('checks live %s sources for legacy usage and running-only tasks', async (source) => {
    const input = usage([task('legacy'), task('ordinary')]);
    const collected = await collectMenubarInputs(deps({
      readUsage: async () => input,
      activities: () => [{ sessionId: 'running-only', phase: 'running', startedAtMs: NOW - 1000 } as never],
      sessionRow: async (sessionId) => ({ title: sessionId, model: 'gpt-5.5', agentKind: 'codex', source: sessionId === 'ordinary' ? null : source }),
    }));

    expect(collected.tasks.map((entry) => entry.sessionId)).toEqual(['ordinary']);
  });

  it('marks the source a running task draws on, and the Cindy balance for managed providers', async () => {
    const collected = await collectMenubarInputs(
      deps({
        listProviders: async () => [
          provider({ id: 'openai', auth: { method: 'oauth', native: 'codex' } } as never),
          provider({ id: 'anthropic' }),
          provider({ id: 'cindy-gateway', auth: { method: 'managed' }, access: { kind: 'managed' } } as never),
        ],
        readBalance: async () => ({ available: 5, fullAmount: 10, burnPerDay: 1, observedAtMs: NOW, currency: 'USD', quota: null }),
        activities: () => [
          { sessionId: 'on-codex', phase: 'running', startedAtMs: NOW - 1000 } as never,
          { sessionId: 'on-cindy', phase: 'running', startedAtMs: NOW - 1000 } as never,
        ],
        sessionRow: async (sessionId) => ({
          title: sessionId,
          model: 'gpt-5.5',
          agentKind: 'codex',
          providerId: sessionId === 'on-codex' ? 'openai' : 'cindy-gateway',
        }),
      }),
    );
    const consuming = collected.sources.filter((source) => source.consuming).map((source) => source.id);
    expect(consuming).toEqual(['cindy', 'openai']);
  });

  it('resolves the implicit default route of a running task to the source it draws on', async () => {
    const codexRoute = { agents: ['codex'], routing: { codex: {} }, models: { codex: [{ id: 'gpt-5.5', mode: 'chat' }] } };
    const collected = await collectMenubarInputs(
      deps({
        listProviders: async () => [
          provider({ id: 'openai', auth: { method: 'oauth', native: 'codex' }, ...codexRoute } as never),
          provider({ id: 'anthropic', agents: ['claude-code'], routing: { 'claude-code': {} }, models: {} } as never),
        ],
        activities: () => [{ sessionId: 'default-route', phase: 'running', startedAtMs: NOW - 1000 } as never],
        // No explicit provider: the session runs on Codex's native default.
        sessionRow: async () => ({ title: 'default route', model: 'gpt-5.5', agentKind: 'codex', providerId: null }),
      }),
    );
    expect(collected.sources.filter((source) => source.consuming).map((source) => source.id)).toEqual(['openai']);
  });

  it('leaves every source still when nothing is running', async () => {
    const collected = await collectMenubarInputs(
      deps({
        readUsage: async () => usage([task('done')]),
        sessionRow: async () => ({ title: 'done', model: 'gpt-5.5', agentKind: 'codex', providerId: 'openai' }),
      }),
    );
    expect(collected.sources.some((source) => source.consuming)).toBe(false);
  });

  it('applies the visible task limit after filtering live sources', async () => {
    const hiddenIds = Array.from({ length: 35 }, (_, index) => 'hidden-' + index);
    const ordinaryIds = Array.from({ length: 31 }, (_, index) => 'ordinary-' + index);
    const collected = await collectMenubarInputs(deps({
      activities: () => [...hiddenIds, ...ordinaryIds].map((sessionId) => ({ sessionId, phase: 'running', startedAtMs: NOW - 1000 } as never)),
      sessionRow: async (sessionId) => ({ title: sessionId, model: 'gpt-5.5', agentKind: 'codex', source: sessionId.startsWith('hidden-') ? 'cindy-make' : null }),
    }));

    expect(collected.tasks.map((entry) => entry.sessionId)).toEqual(ordinaryIds.slice(0, 30));
  });
});

describe('distinctRemoteSubscriptions', () => {
  const week = (usedPercent: number, resetsAtMs = NOW + 3 * 86_400_000) =>
    ({ kind: 'week' as const, usedPercent, resetsAtMs, windowMinutes: 10_080 });

  function sub(id: string, extra: Partial<MenubarSubscriptionInput> = {}): MenubarSubscriptionInput {
    return {
      kind: 'subscription', id, providerId: 'anthropic', family: 'claude', logoSvg: '', brand: 'Claude',
      account: null, plan: 'Max', windows: [week(40)], credits: null, creditsUnlimited: false, prepaidUsd: null,
      updatedAtMs: NOW, accountKeys: [], ...extra,
    };
  }
  const remote = (id: string, extra: Partial<MenubarSubscriptionInput> = {}) =>
    sub(`remote:${id}`, { device: { id, name: id }, ...extra });

  it('drops an account this computer already shows, matched by its fingerprint', () => {
    const local = sub('anthropic', { accountKeys: ['claude:fp:abc'], windows: [week(40)] });
    const same = remote('studio', { accountKeys: ['claude:fp:abc'], windows: [week(55)] });
    expect(distinctRemoteSubscriptions([local], [same])).toEqual([]);
  });

  it('keeps a different account even when its numbers happen to match', () => {
    const local = sub('anthropic', { accountKeys: ['claude:fp:abc'] });
    const other = remote('studio', { accountKeys: ['claude:fp:xyz'] });
    expect(distinctRemoteSubscriptions([local], [other])).toEqual([other]);
  });

  it('does not merge two people in one Codex workspace', () => {
    const local = sub('openai', { family: 'codex', accountKeys: ['codex:id:ws-1', 'codex:identity:a@x.com'] });
    const teammate = remote('studio', { family: 'codex', accountKeys: ['codex:id:ws-1', 'codex:identity:b@x.com'] });
    expect(distinctRemoteSubscriptions([local], [teammate])).toEqual([teammate]);
  });

  it('falls back to identical windows when neither side names the account', () => {
    const local = sub('anthropic', { windows: [week(40)] });
    const mirror = remote('studio', { windows: [week(41, NOW + 3 * 86_400_000 + 30_000)] });
    const other = remote('laptop', { windows: [week(70)] });
    expect(distinctRemoteSubscriptions([local], [mirror, other])).toEqual([other]);
  });

  it('lists an account shared by two other computers once, from the fresher reading', () => {
    const older = remote('studio', { accountKeys: ['claude:fp:abc'], updatedAtMs: NOW - 600_000 });
    const newer = remote('laptop', { accountKeys: ['claude:fp:abc'], updatedAtMs: NOW });
    expect(distinctRemoteSubscriptions([], [older, newer])).toEqual([newer]);
  });

  it('leaves out other-computer accounts it could not read', () => {
    expect(distinctRemoteSubscriptions([], [remote('studio', { windows: [] })])).toEqual([]);
  });
});

describe('topModels', () => {
  it('keeps the token leaders even when they cost little', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `paid-${i}`, harness: 'codex' as const, money: 100 - i, tokens: 10 }));
    rows.push({ name: 'free-heavy', harness: 'codex' as const, money: 0, tokens: 1_000_000 });
    const top = topModels(rows);
    expect(top.slice(0, 8).map((row) => row.name)).toEqual(rows.slice(0, 8).map((row) => row.name));
    expect(top.map((row) => row.name)).toContain('free-heavy');
  });
});

// Unit: Kimi quota must not inherit Codex plan identity or show expired/stale amounts.
it('maps Kimi periods and removes expired or stale numbers from the menu bar', () => {
  const account = provider({ id: 'kimi-coding', name: 'Kimi Code' });
  const result = { status: 'ready', stale: false, snapshot: { kind: 'kimi-coding-quota', fetchedAt: NOW, windows: [
    { id: 'limit_5h', usedPercent: 20, resetsAt: NOW + 3600_000 },
    { id: 'limit_7d', usedPercent: 100, resetsAt: NOW - 1 },
    { id: 'limit_month_total', usedPercent: 30, resetsAt: null },
  ] } } as const;
  const source = kimiSource(account, result as never, NOW);
  expect(source).toMatchObject({ family: 'kimi', brand: 'Kimi Code', account: null, plan: null, credits: null });
  expect(source.windows).toMatchObject([{ kind: 'session', usedPercent: 20, windowMinutes: 300 }, { kind: 'period', usedPercent: 30, windowMinutes: 0 }]);
  expect(kimiSource(account, { ...result, stale: true } as never, NOW).windows).toEqual([]);
  expect(kimiSource(account, { status: 'unavailable', error: 'auth' }, NOW).windows).toEqual([]);
});
