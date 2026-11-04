import { z } from 'zod';
import type { ProviderShareBudgetStatus } from './providerShareBudget';
import type { ProviderUsageDayView } from './providerShare';

export const PROVIDER_SHARE_INSIGHTS_CHANNEL = 'provider-share:insights:v1';

export interface ProviderShareVisibility {
  quota: boolean;
  usage: boolean;
}

export interface ProviderShareQuotaAccount {
  state: 'ready' | 'unsupported' | 'unavailable' | 'offline' | 'needs-update' | 'unlimited';
  updatedAt: number | null;
  windows: Array<{
    kind: 'session' | 'week' | 'scoped';
    label: string | null;
    remainingPercent: number;
    resetsAt: number | null;
    windowMinutes: number | null;
  }>;
  balance: {
    remaining: number;
    total: number | null;
    currency: 'USD' | 'CNY';
    resetsAt: number | null;
    pools: Array<{
      kind: 'plan' | 'purchased' | 'promotional';
      remaining: number;
      total: number | null;
    }>;
  } | null;
}

export type ProviderShareUsageDay = Omit<ProviderUsageDayView, 'providerId' | 'memberKey'>;

export interface ProviderShareUsageDetails {
  todayKey: string;
  coverageStart: string | null;
  parties: Array<{
    key: string;
    displayName: string;
    avatarUrl: string | null;
    isYou: boolean;
    isOwner: boolean;
    isRelay: boolean;
    lastUsedAt: number | null;
    days: ProviderShareUsageDay[];
  }>;
}

export interface ProviderShareInsights {
  version: 1;
  memberBudget?: ProviderShareBudgetStatus | null;
  capabilities: ProviderShareVisibility;
  status: {
    quota: 'disabled' | 'ready' | 'unavailable';
    usage: 'disabled' | 'not-requested' | 'ready' | 'unavailable';
  };
  quota: { group: boolean; partial: boolean; accounts: ProviderShareQuotaAccount[] } | null;
  usage: ProviderShareUsageDetails | null;
}

// 对端返回值只保留展示字段；未知版本或缺字段不当成零额度。
const number = z.number().finite();
// 有限数仍可能超出 Date 范围；拒绝会使接收端日期格式化抛错的时间戳。
const timestamp = number.refine((value) => Number.isFinite(new Date(value).getTime()));
const money = z.object({ amount: number, currency: z.enum(['USD', 'CNY']) });
const quotaAccount = z.object({
  state: z.enum(['ready', 'unsupported', 'unavailable', 'offline', 'needs-update', 'unlimited']),
  updatedAt: timestamp.nullable(),
  windows: z
    .array(
      z.object({
        kind: z.enum(['session', 'week', 'scoped']),
        label: z.string().max(128).nullable(),
        remainingPercent: number.min(0).max(100),
        resetsAt: timestamp.nullable(),
        windowMinutes: number.nullable(),
      }),
    )
    .max(32),
  balance: z
    .object({
      remaining: number,
      total: number.nullable(),
      currency: z.enum(['USD', 'CNY']),
      resetsAt: timestamp.nullable(),
      pools: z
        .array(
          z.object({
            kind: z.enum(['plan', 'purchased', 'promotional']),
            remaining: number,
            total: number.nullable(),
          }),
        )
        .max(3),
    })
    .nullable(),
});
const status = z.enum(['disabled', 'ready', 'unavailable']);
const schema = z.object({
  version: z.literal(1),
  memberBudget: z.object({
    state: z.enum(['recorded', 'empty', 'unavailable']), enabled: z.boolean(),
    windowStart: z.iso.date(), windowEnd: z.iso.date(), nextWindowAt: timestamp,
    totalTokens: number.min(0).nullable(),
    recommendedModel: z.string().max(512).nullable(),
    rules: z.array(z.object({
      id: z.string().max(512), models: z.array(z.string().max(512)).length(1),
      tokens: number.min(0).nullable(), usedPercent: number.min(0).max(100).nullable(),
      limitPercent: number.positive().max(100), wouldBlock: z.boolean(), blocked: z.boolean(),
    })).max(32),
  }).nullable().optional(),
  capabilities: z.object({ quota: z.boolean(), usage: z.boolean() }),
  status: z.object({
    quota: status,
    usage: z.enum(['disabled', 'not-requested', 'ready', 'unavailable']),
  }),
  quota: z
    .object({ group: z.boolean(), partial: z.boolean(), accounts: z.array(quotaAccount).max(512) })
    .nullable(),
  usage: z
    .object({
      todayKey: z.iso.date(),
      coverageStart: z.iso.date().nullable(),
      parties: z.array(
        z.object({
          key: z.string(),
          displayName: z.string(),
          avatarUrl: z.string().nullable(),
          isYou: z.boolean(),
          isOwner: z.boolean(),
          isRelay: z.boolean(),
          lastUsedAt: timestamp.nullable(),
          days: z
            .array(
              z.object({
                day: z.iso.date(),
                kind: z.string(),
                model: z.string(),
                turns: number,
                inputTokens: number,
                outputTokens: number,
                cacheReadTokens: number,
                cacheCreateTokens: number,
                amount: money.nullable(),
              }),
            )
            .max(5000),
        }),
      ),
    })
    .nullable(),
});

export function parseProviderShareInsights(raw: unknown): ProviderShareInsights | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  // 权限关闭时即使对端错误地附带数据，也不能让它进入本机展示缓存。
  for (const key of ['quota', 'usage'] as const) {
    if (!value.capabilities[key]) {
      value[key] = null;
      value.status[key] = 'disabled';
    } else if (value.status[key] === 'disabled') return null;
    else if (value.status[key] !== 'ready') value[key] = null;
    else if (value[key] === null) return null;
  }
  return value;
}
