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
  modelDisplayNames,
  opencodeGoSource,
  usageScope,
} from '../collect';
import { readRemoteSubscriptions, retainRemoteSubscriptions, REMOTE_RETAIN_MS, type RemoteSeen, type RemoteSubscriptionDeps } from '../remoteSubscriptions';
import { topModels, type MenubarSubscriptionInput } from '../snapshot';
import type { UsageHistoryPayload, UsageHistoryTask } from '../../usage/usageHistory';
import type { SubscriptionPoolView } from '../../../shared/subscriptionAccounts';

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

  // #10110, unit: collectMenubarInputs must display accounts rather than provider entries.
  // Existing coverage only deduplicated remote sources. Minimal failure: one provider,
  // two accounts; or two local providers pointing at the same account.
  const pool: SubscriptionPoolView = {
    providerId: 'openai', configured: true, strategy: 'round',
    accounts: ['default', 'extra'].map((id, index) => ({
      id, paused: false, limit: 4, weight: 1, directory: `/fixture/${id}`,
      identity: `${id}@example.com`, plan: index ? 'pro' : 'plus', status: 'ready', running: index,
      usage: { codex: { credits: null, buckets: { codex: {
        limitId: 'codex', limitName: null, updatedAt: NOW,
        primary: null, secondary: { usedPercent: index ? 35 : 90, windowMinutes: 10_080, resetsAt: nowSec + 86_400 },
      } } } },
    })),
  };

  it('shows each pooled account with its own plan, quota and running marker', async () => {
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => [provider({ id: 'openai', openAiAccount: { identity: 'wrong@example.com' } } as never)],
      readSubscriptionPool: async () => pool,
      readCodexResets: async () => ({ count: 2, earliestExpiryMs: null }),
    }));
    expect(collected.sources).toMatchObject([
      { id: 'openai', account: 'default@example.com', plan: 'Plus', consuming: false,
        windows: [{ usedPercent: 90 }], resetCredits: { count: 2 } },
      { id: 'openai:account:extra', providerId: 'openai', account: 'extra@example.com', plan: 'Pro', consuming: true,
        windows: [{ usedPercent: 35 }], resetCredits: null },
    ]);
  });

  // #10405, unit: a legacy connection can own several accounts. Previous fixtures only
  // used built-in ids, hiding both the missed pool read and the wrong Claude projection.
  it.each(['local', 'remote'])('reads a legacy Codex target pool on %s', async location => {
    const legacy = provider({ id: 'legacy-codex', subscriptionAccountPool: 'openai',
      auth: { method: 'oauth', native: 'codex' }, remoteInvocationEnabled: true,
      agents: ['codex'], models: { codex: [] } });
    const owned: SubscriptionPoolView = { ...pool, providerId: legacy.id, kind: 'openai',
      accounts: pool.accounts.map((account, index) => ({ ...account, id: `owned-${index}` })) };
    const calls: string[] = [];
    const remote = location === 'remote' ? (await readRemoteSubscriptions(remoteDeps(async (_device, channel) => {
      calls.push(channel);
      return { ok: true, result: owned };
    }, [legacy]))).sources.filter(source => source.providerId === legacy.id) : [];
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => location === 'local' ? [legacy] : [],
      readSubscriptionPool: async id => { expect(id).toBe(legacy.id); return owned; },
      readRemoteSubscriptions: async () => remote,
    }));
    expect(collected.sources).toMatchObject([
      { providerId: legacy.id, family: 'codex', account: 'default@example.com', windows: [{ usedPercent: 90 }] },
      { providerId: legacy.id, family: 'codex', account: 'extra@example.com', windows: [{ usedPercent: 35 }] },
    ]);
    if (location === 'remote') expect(calls).not.toContain('maker:usage:account');
  });

  // #10110 review: email is not a Codex workspace identity. Previous fixtures
  // only covered different emails; two legal pool entries sharing an email lost
  // one quota and transferred its running marker. Unit, real collector/peer reader.
  it.each(['local', 'remote'])('keeps same-email Codex workspaces separate on %s', async (location) => {
    const workspaces = { ...pool, accounts: pool.accounts.map((account, index) => ({
      ...account, identity: 'same@example.com', plan: index ? 'team' : 'plus',
    })) };
    const remote = location === 'remote'
      ? (await readRemoteSubscriptions(remoteDeps(async () => ({ ok: true, result: workspaces })))).sources : [];
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => location === 'local' ? [provider({ id: 'openai' })] : [],
      readSubscriptionPool: async () => workspaces,
      readRemoteSubscriptions: async () => remote,
    }));
    expect(collected.sources).toHaveLength(2);
    expect(collected.sources).toMatchObject([
      { plan: 'Plus', windows: [{ usedPercent: 90 }], consuming: false },
      { plan: 'Team', windows: [{ usedPercent: 35 }], consuming: location === 'local' },
    ]);
  });

  it('deduplicates local accounts while retaining different people in one workspace', async () => {
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => ['openai', 'legacy', 'other'].map((id) => provider({
        id, auth: { method: 'oauth', native: 'codex' },
        openAiAccount: { identity: id === 'other' ? 'other@example.com' : 'same@example.com' },
      } as never)),
      readCodex: async () => ({ accountId: 'workspace', primary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: nowSec + 86_400 } }) as never,
    }));
    expect(collected.sources.map((source) => source.id)).toEqual(['openai', 'other']);
  });

  // #10204 review, unit: quota-only plan metadata was overwritten with null.
  // Prior fixtures supplied the same plan in both places and missed this loss.
  it.each(['local', 'remote'])('keeps Claude pool plans and per-model windows attached to their account on %s', async location => {
    const claudePool: SubscriptionPoolView = {
      ...pool, providerId: 'anthropic', accounts: pool.accounts.map((account, index) => ({
        ...account, plan: index ? 'max_20x' : undefined, usage: { claude: {
          updatedAt: NOW, subscriptionType: 'pro',
          fiveHour: { utilization: index ? 25 : 80, resetsAt: nowSec + 3600 },
          sevenDay: { utilization: index ? 35 : 90, resetsAt: nowSec + 86_400 },
          scoped: [{ modelDisplayName: 'Sonnet', utilization: index ? 40 : 95, resetsAt: nowSec + 86_400 }],
        } },
      })),
    };
    const remote = location === 'remote'
      ? (await readRemoteSubscriptions(remoteDeps(async () => ({ ok: true, result: claudePool }), [], 'anthropic'))).sources : [];
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => location === 'local' ? [provider({ id: 'anthropic' })] : [],
      readSubscriptionPool: async () => claudePool,
      readRemoteSubscriptions: async () => remote,
    }));
    const prefix = location === 'remote' ? 'remote:peer:' : '';
    expect(collected.sources).toMatchObject([
      { id: `${prefix}anthropic`, account: 'default@example.com', plan: 'Pro',
        windows: [{ usedPercent: 80 }, { usedPercent: 90 }, { label: 'Sonnet', usedPercent: 95 }] },
      { id: `${prefix}anthropic:account:extra`, account: 'extra@example.com', plan: 'Max 20x',
        windows: [{ usedPercent: 25 }, { usedPercent: 35 }, { label: 'Sonnet', usedPercent: 40 }] },
    ]);
  });

  it('does not resurrect a paused pooled account through its migrated provider alias', async () => {
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => [provider({ id: 'openai' }), provider({ id: 'legacy', subscriptionPoolAlias: true,
        auth: { method: 'oauth', native: 'codex' }, openAiAccount: { identity: 'extra@example.com' } } as never)],
      readSubscriptionPool: async () => ({ ...pool, accounts: pool.accounts.map(account => ({ ...account, paused: true })) }),
    }));
    expect(collected.sources).toEqual([]);
  });

  it.each(['paused', 'signed-out', 'unavailable', 'failed'] as const)('never borrows default quota when pool is %s', async (state) => {
    const collected = await collectMenubarInputs(deps({
      listProviders: async () => [provider({ id: 'openai', openAiAccount: { identity: 'wrong@example.com' } } as never)],
      readSubscriptionPool: async () => {
        if (state === 'failed') throw new Error('offline');
        return { ...pool, accounts: [ { ...pool.accounts[1],
          paused: state === 'paused', status: state === 'paused' ? 'ready' : state,
        } ] };
      },
    }));
    if (state === 'paused') expect(collected.sources).toEqual([]);
    else {
      expect(collected.sources).toHaveLength(1);
      expect(collected.sources[0]).toMatchObject({ windows: [] });
      expect(collected.sources[0]).not.toMatchObject({ account: 'wrong@example.com' });
    }
  });

  // Same regression through the peer reader: provider identity must never label another
  // pooled account's quota. Only unsupported peers may use the default-account fallback.
  function remoteDeps(invoke: RemoteSubscriptionDeps['invoke'], aliases: ProviderView[] = [], providerId = 'openai'): RemoteSubscriptionDeps {
    return { nowMs: NOW, listDevices: async () => ({ devices: [{
      deviceId: 'peer', name: 'Peer', isSelf: false, online: true, remoteControlEnabled: true,
      controlEnabled: true, platform: 'darwin', appVersion: '9.0.0',
    }] as never }), invoke: async (id, channel, args) => channel === 'maker:provider:list'
      ? { ok: true, result: { providers: [provider({ id: providerId, remoteInvocationEnabled: true,
          agents: ['codex'], models: { codex: [] }, openAiAccount: { identity: 'wrong@example.com' } } as never), ...aliases] } }
      : invoke(id, channel, args),
    };
  }

  it('does not resurrect paused peer accounts through migrated aliases', async () => {
    const calls: unknown[] = [];
    const result = await readRemoteSubscriptions(remoteDeps(async (_id, channel, args) => {
      calls.push([channel, args]);
      return { ok: true, result: { ...pool, accounts: pool.accounts.map(account => ({ ...account, paused: true })) } };
    }, [provider({ id: 'legacy', subscriptionPoolAlias: true, remoteInvocationEnabled: true,
      agents: ['codex'], models: { codex: [] }, auth: { method: 'oauth', native: 'codex' } } as never)]));
    expect(result.sources).toEqual([]);
    expect(result.failed.size).toBe(0);
    expect(calls).toEqual([['maker:subscription-accounts', [{ action: 'read', providerId: 'openai' }]]]);
  });

  it('expands the peer account pool and retains its entries across a temporary read failure', async () => {
    const result = await readRemoteSubscriptions(remoteDeps(async (_id, channel) => {
      expect(channel).toBe('maker:subscription-accounts');
      return { ok: true, result: pool };
    }));
    expect(result.sources).toMatchObject([
      { id: 'remote:peer:openai', account: 'default@example.com', plan: 'Plus', consuming: false, windows: [{ usedPercent: 90 }] },
      { id: 'remote:peer:openai:account:extra', account: 'extra@example.com', plan: 'Pro', consuming: false, windows: [{ usedPercent: 35 }] },
    ]);
    const previous = retainRemoteSubscriptions(new Map(), result, NOW);
    const failed = await readRemoteSubscriptions(remoteDeps(async () => ({ ok: false, error: { code: 'TIMEOUT', message: 'offline' } })));
    expect(failed.sources).toEqual([]);
    expect(retainRemoteSubscriptions(previous.seen, failed, NOW + 1000).sources).toHaveLength(2);
    const removed = await readRemoteSubscriptions(remoteDeps(async () => ({ ok: true, result: { ...pool, accounts: [] } })));
    expect(retainRemoteSubscriptions(previous.seen, removed, NOW + 1000).sources).toEqual([]);
  });

  it.each(['openai', 'anthropic'])('uses a serializable default scope for an older %s peer', async (providerId) => {
    const result = await readRemoteSubscriptions(remoteDeps(async (_id, channel, args) => {
      if (channel === 'maker:subscription-accounts') return { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'old peer' } };
      // A missing array argument becomes null over device-link; the legacy reader rejects
      // null provider IDs, so pass an explicit provider instead of an undefined placeholder.
      expect(JSON.parse(JSON.stringify(args))).toEqual(providerId === 'openai'
        ? ['codex', 'openai', 'default-subscription-account']
        : ['anthropic', false, 'default-subscription-account']);
      return { ok: true, result: providerId === 'openai'
        ? { primary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: nowSec + 86_400 } }
        : { sevenDay: { utilization: 20, resetsAt: nowSec + 86_400 } } };
    }, [], providerId));
    expect(result.sources).toMatchObject([{ id: `remote:peer:${providerId}`, windows: [{ usedPercent: 20 }] }]);
  });

  it('rejects a peer pool for the wrong provider without borrowing default quota', async () => {
    const result = await readRemoteSubscriptions(remoteDeps(async (_id, channel) => {
      expect(channel).toBe('maker:subscription-accounts');
      return { ok: true, result: { ...pool, providerId: 'anthropic' } };
    }));
    expect(result.sources).toEqual([]);
    expect(result.failed.has('remote:peer:openai')).toBe(true);
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

  // Regression: a computer going offline (or failing one read) made its accounts vanish from the panel and widgets.
  it('keeps an unreachable computer’s accounts with their age until the retention runs out', () => {
    const seenAtMs = NOW - 3 * 3_600_000;
    const session = { kind: 'session' as const, usedPercent: 80, resetsAtMs: NOW - 60_000, windowMinutes: 300 };
    const studio = remote('studio', { windows: [week(40), session] });
    const laptop = remote('laptop');
    const gone = remote('sold');
    const previous = new Map<string, RemoteSeen>(
      [studio, laptop, gone].map((source) => [source.id, { source, seenAtMs }]),
    );
    const read = { sources: [], unreachable: new Set(['studio']), failed: new Set(['remote:laptop']), incomplete: true };

    const { sources, seen } = retainRemoteSubscriptions(previous, read, NOW);
    expect(sources.map((source) => [source.id, source.lastSeenAtMs])).toEqual([
      ['remote:studio', seenAtMs], ['remote:laptop', seenAtMs],
    ]);
    // A window that reset while the computer was away counts as refilled.
    expect(sources[0]!.windows[1]).toMatchObject({ usedPercent: 0, resetsAtMs: null });
    expect(retainRemoteSubscriptions(seen, read, seenAtMs + REMOTE_RETAIN_MS).sources).toEqual([]);

    const fresh = remote('studio', { windows: [week(10)] });
    const back = retainRemoteSubscriptions(seen, { sources: [fresh], unreachable: new Set(), failed: new Set(), incomplete: false }, NOW);
    expect(back.sources).toEqual([fresh]);
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

it('maps OpenCode Go rolling, weekly and monthly windows without showing stale numbers', () => {
  const account = provider({ id: 'opencode-go', name: 'OpenCode Go' });
  const result = { status: 'ready', stale: false, snapshot: { kind: 'opencode-go-quota', fetchedAt: NOW, windows: [
    { id: 'rolling', usedPercent: 12, limited: false, resetsAt: NOW + 3600_000 },
    { id: 'weekly', usedPercent: 34, limited: false, resetsAt: NOW + 86_400_000 },
    { id: 'monthly', usedPercent: 100, limited: true, resetsAt: NOW - 1 },
  ] } } as const;
  const source = opencodeGoSource(account, result as never, NOW);
  expect(source).toMatchObject({ family: 'opencode-go', brand: 'OpenCode Go', account: null, plan: null, credits: null });
  expect(source.windows).toMatchObject([
    { kind: 'session', label: 'rolling', usedPercent: 12, windowMinutes: 300 },
    { kind: 'week', label: 'weekly', usedPercent: 34, windowMinutes: 10_080 },
  ]);
  expect(opencodeGoSource(account, { ...result, stale: true } as never, NOW).windows).toEqual([]);
});

// iPhone usage widgets split each day by model: the five with the most tokens in the last 30 days keep
// their own series and everything else is summed last.
it('splits daily value and tokens by the five busiest models and sums the rest', () => {
  const money = (amount: number) => ({ amount, currency: 'USD', approximate: false, kind: 'actual-cost' }) as const;
  const days = dayKeysEndingAt('2026-10-11', 2);
  const row = (day: string, model: string, amount: number) =>
    ({ day, agentKind: 'codex', model, tokens: amount * 1000, money: money(amount), apiMoney: money(0), subscriptionEstimateMoney: money(amount) });
  const payload = { todayKey: '2026-10-11', modelDaily: [
    ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((model, i) => row('2026-10-11', model, 60 - i * 10)),
    row('2026-10-10', 'm6', 4),
  ] } as unknown as UsageHistoryPayload;
  const series = usageScope(payload, days, []).modelSeries!;
  expect(series.models.map((m) => m.name)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  expect(series.daily).toEqual([[0, 0, 0, 0, 0, 4], [60, 50, 40, 30, 20, 10]]);
  expect(series.tokens[1]).toEqual([60_000, 50_000, 40_000, 30_000, 20_000, 10_000]);
});

// Usage rows keep wire ids; the panel and widgets show catalog names and count one model once,
// whichever route (Claude Code, Pi through a namespaced provider) it ran on.
it('labels usage with catalog display names and folds route variants together', () => {
  const money = (amount: number) => ({ amount, currency: 'USD', approximate: false, kind: 'actual-cost' }) as const;
  const days = dayKeysEndingAt('2026-10-11', 1);
  const row = (agentKind: string, model: string) =>
    ({ day: '2026-10-11', agentKind, model, tokens: 100, money: money(1), apiMoney: money(0), subscriptionEstimateMoney: money(1) });
  const names = modelDisplayNames([
    { models: { codex: [{ id: 'codex/gpt-6-astra', name: 'Codex GPT-6 Astra' }] } },
    { models: { 'claude-code': [{ id: 'claude-opus-5-5[1m]', name: 'Opus 5.5' }], codex: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }] } },
  ] as never);
  const payload = { todayKey: '2026-10-11', modelDaily: [
    row('claude-code', 'claude-opus-5-5'), row('pi', 'anthropic/claude-opus-5-5'), row('codex', 'gpt-6-astra'), row('codex', 'mystery-1'),
  ] } as unknown as UsageHistoryPayload;
  const series = usageScope(payload, days, [], names).modelSeries!;
  expect(series.models.map((m) => m.name)).toEqual(['Opus 5.5', 'GPT-6 Astra', 'mystery-1']);
  expect(series.tokens[0]).toEqual([200, 100, 100, 0]);
});
