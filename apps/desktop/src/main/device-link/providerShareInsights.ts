import { createHash } from 'node:crypto';
import { MAX_FRAME_BYTES, type ProviderShareOwned } from '@cindy/device-link';
import type { ProviderUsageHistoryView } from '../../shared/providerShare.js';
import type {
  ProviderShareInsights,
  ProviderShareQuotaAccount,
  ProviderShareUsageDay,
  ProviderShareUsageDetails,
  ProviderShareVisibility,
} from '../../shared/providerShareInsights.js';
import type { ProviderShareGuestAccess } from './providerShareHost.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface ProviderShareInsightsDeps {
  captureScope(): () => void;
  scopeKey(): string;
  access(peer: string): ProviderShareGuestAccess | null;
  revision(): number;
  visibility(providerId: string): ProviderShareVisibility & { revision: number };
  shares(): readonly ProviderShareOwned[];
  owner(): { displayName: string; avatarUrl: string | null };
  history(providerId: string): Promise<ProviderUsageHistoryView>;
  quota(
    providerId: string,
  ): Promise<{ group: boolean; partial: boolean; accounts: ProviderShareQuotaAccount[] }>;
}

function publicDays(days: ProviderUsageHistoryView['self']['days']): ProviderShareUsageDay[] {
  const merged = new Map<string, ProviderShareUsageDay>();
  for (const row of days) {
    const key = JSON.stringify([row.day, row.kind, row.model]);
    const previous = merged.get(key);
    const amount = row.amount ? { amount: row.amount.amount, currency: row.amount.currency } : null;
    if (!previous) {
      merged.set(key, {
        day: row.day,
        kind: row.kind,
        model: row.model,
        turns: row.turns,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreateTokens: row.cacheCreateTokens,
        amount,
      });
    } else {
      previous.turns += row.turns;
      previous.inputTokens += row.inputTokens;
      previous.outputTokens += row.outputTokens;
      previous.cacheReadTokens += row.cacheReadTokens;
      previous.cacheCreateTokens += row.cacheCreateTokens;
      previous.amount =
        previous.amount && amount && previous.amount.currency === amount.currency
          ? { amount: previous.amount.amount + amount.amount, currency: amount.currency }
          : null;
    }
  }
  return [...merged.values()];
}

function publicUsage(
  history: ProviderUsageHistoryView,
  share: ProviderShareOwned,
  viewer: string,
  owner: ReturnType<ProviderShareInsightsDeps['owner']>,
): ProviderShareUsageDetails {
  const memberUsage = new Map(
    history.members
      .filter((item) => item.shareId === share.shareId)
      .map((item) => [item.memberId, item]),
  );
  return {
    todayKey: history.todayKey,
    coverageStart: history.coverageStart,
    parties: [
      {
        key: 'owner',
        displayName: owner.displayName,
        avatarUrl: owner.avatarUrl,
        isYou: false,
        isOwner: true,
        isRelay: false,
        lastUsedAt: history.self.lastUsedAt,
        days: publicDays(history.self.days),
      },
      ...share.members.map((member) => {
        const usage = memberUsage.get(member.memberId);
        return {
          key: createHash('sha256')
            .update(JSON.stringify([share.shareId, member.memberId]))
            .digest('hex')
            .slice(0, 24),
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          isYou: member.memberId === viewer,
          isOwner: false,
          isRelay: false,
          lastUsedAt: usage?.lastUsedAt ?? null,
          days: publicDays(usage?.days ?? []),
        };
      }),
      ...(history.relays.length
        ? [
            {
              key: 'relay',
              displayName: '',
              avatarUrl: null,
              isYou: false,
              isOwner: false,
              isRelay: true,
              lastUsedAt: history.relays.reduce<number | null>(
                (last, relay) =>
                  relay.lastUsedAt === null ? last : Math.max(last ?? 0, relay.lastUsedAt),
                null,
              ),
              days: publicDays(history.relays.flatMap((relay) => relay.days)),
            },
          ]
        : []),
    ],
  };
}

// Match the existing history budget, reserving room for the invoke envelope.
const INSIGHTS_MAX_BYTES = MAX_FRAME_BYTES - 1_024;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function boundInsightsFrame(result: ProviderShareInsights): void {
  // An oversized capability must not turn the other capability into a transport error.
  if (result.quota && jsonBytes({ ...result, usage: null }) > INSIGHTS_MAX_BYTES) {
    result.quota = null;
    result.status.quota = 'unavailable';
  }
  const usage = result.usage;
  if (!usage || jsonBytes(result) <= INSIGHTS_MAX_BYTES) return;
  const rows = usage.parties.flatMap((party, index) => party.days.map((row) => ({ index, row })));
  rows.sort((a, b) => b.row.day.localeCompare(a.row.day));
  const bounded: ProviderShareUsageDetails = {
    ...usage,
    coverageStart: null,
    parties: usage.parties.map((party) => ({ ...party, days: [] })),
  };
  let bytes = jsonBytes({ ...result, usage: bounded });
  let kept = 0;
  for (const { index, row } of rows) {
    const days = bounded.parties[index]!.days;
    // Account for JSON array separators and the coverage marker as well as UTF-8 row bytes.
    const nextBytes =
      bytes +
      jsonBytes(row) +
      (days.length ? 1 : 0) +
      jsonBytes(row.day) -
      jsonBytes(bounded.coverageStart);
    if (nextBytes > INSIGHTS_MAX_BYTES) break;
    days.push(row);
    bounded.coverageStart = row.day;
    bytes = nextBytes;
    kept++;
  }
  // Never silently omit people or display zero usage when no history can fit.
  if (bytes > INSIGHTS_MAX_BYTES || (rows.length > 0 && kept === 0)) {
    result.usage = null;
    result.status.usage = 'unavailable';
  } else {
    result.usage = bounded;
  }
}

/** 最小只读投影；权限检查保留到实际发送，包括背压队列重发。 */
export function createProviderShareInsightsReader(deps: ProviderShareInsightsDeps) {
  const checks = new WeakMap<object, { peer: string; assertCurrent(): void }>();
  let cacheScope: { owner: string; revision: number } | null = null;
  const histories = new Map<
    string,
    {
      visibilityRevision: number;
      expiresAt: number;
      read: Promise<ProviderUsageHistoryView>;
    }
  >();
  const read = async (peer: string, raw: unknown): Promise<ProviderShareInsights> => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 2 ||
      typeof (raw as { includeUsage?: unknown }).includeUsage !== 'boolean' ||
      (raw as { version?: unknown }).version !== 1
    ) {
      throwIpcError('INVALID_PARAMS', 'Invalid provider share insights request');
    }
    const includeUsage = (raw as { includeUsage: boolean }).includeUsage;
    const assertOwner = deps.captureScope();
    const owner = deps.scopeKey();
    const access = deps.access(peer);
    if (!access) throwIpcError('PERMISSION_DENIED', 'Provider share is not available');
    const visibility = deps.visibility(access.providerId);
    const revision = deps.revision();
    const assertCurrent = () => {
      assertOwner();
      const latest = deps.access(peer);
      if (
        deps.scopeKey() !== owner ||
        !latest ||
        latest.providerId !== access.providerId ||
        latest.memberId !== access.memberId ||
        latest.shareId !== access.shareId ||
        deps.revision() !== revision ||
        deps.visibility(access.providerId).revision !== visibility.revision
      ) {
        throwIpcError('PERMISSION_DENIED', 'Provider share access changed');
      }
    };
    assertCurrent();
    if (cacheScope?.owner !== owner || cacheScope.revision !== revision) {
      histories.clear();
      cacheScope = { owner, revision };
    }
    const now = Date.now();
    // Retain only current, unexpired provider entries, not historical authorization generations.
    for (const [providerId, entry] of histories) {
      if (
        entry.expiresAt <= now ||
        entry.visibilityRevision !== deps.visibility(providerId).revision
      ) {
        histories.delete(providerId);
      }
    }
    let cached = histories.get(access.providerId);
    if (!visibility.usage) {
      histories.delete(access.providerId);
    } else if (includeUsage && !cached) {
      const read = deps.history(access.providerId);
      cached = { visibilityRevision: visibility.revision, expiresAt: now + 15_000, read };
      histories.set(access.providerId, cached);
      void read.catch(() => {
        if (histories.get(access.providerId)?.read === read) histories.delete(access.providerId);
      });
    }
    const [historyResult, quotaResult] = await Promise.allSettled([
      visibility.usage && includeUsage ? cached!.read : null,
      visibility.quota ? deps.quota(access.providerId) : null,
    ]);
    assertCurrent();
    const share = deps.shares().find((item) => item.shareId === access.shareId);
    if (!share) throwIpcError('PERMISSION_DENIED', 'Provider share is not available');
    const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
    const quota = quotaResult.status === 'fulfilled' ? quotaResult.value : null;
    const result: ProviderShareInsights = {
      version: 1,
      capabilities: { quota: visibility.quota, usage: visibility.usage },
      status: {
        quota: !visibility.quota ? 'disabled' : quota ? 'ready' : 'unavailable',
        usage: !visibility.usage
          ? 'disabled'
          : !includeUsage
            ? 'not-requested'
            : history
              ? 'ready'
              : 'unavailable',
      },
      quota,
      usage: history ? publicUsage(history, share, access.memberId, deps.owner()) : null,
    };
    boundInsightsFrame(result);
    checks.set(result, { peer, assertCurrent });
    return result;
  };
  return Object.assign(read, {
    isCurrent(peer: string, result: unknown): boolean {
      const check = result && typeof result === 'object' ? checks.get(result) : undefined;
      if (!check || check.peer !== peer) return false;
      try {
        check.assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
  });
}
