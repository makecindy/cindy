/**
 * Presentation helpers shared by the Subagent list and detail views.
 *
 * Pure functions only — the panel's data orchestration lives in
 * `SubagentsBody.tsx` and the markup in the sibling components. Keeping these
 * here means the list row, the detail header and the child overview card all
 * derive their status glyph and meta line from one place instead of drifting.
 */

import {
  AlertCircle,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type {
  SubagentChildRun,
  SubagentProvider,
  SubagentRun,
  SubagentRunDetail,
  SubagentRunUsage,
} from '@cindy/maker-shared/subagent-workspace';

import { formatCompactTokens } from '@/lib/usageFormat';

/** Run status plus the queued state only children can be in. */
export type SubagentDisplayStatus = SubagentRun['status'] | 'queued';

export function statusIcon(status: SubagentDisplayStatus): LucideIcon {
  if (status === 'completed') return CheckCircle2;
  if (status === 'failed') return AlertCircle;
  if (status === 'stopped') return CircleStop;
  return LoaderCircle;
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function providerLabel(provider: SubagentProvider): string {
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  // 轮 33 C2:'PI' → 'Pi'(与全产品命名一致)。
  return 'Pi';
}

export function runTitle(run: SubagentRun, fallback: string): string {
  return run.title?.trim() || run.description?.trim() || fallback;
}

export function runMatchesSelection(
  run: SubagentRunDetail,
  provider: SubagentProvider | null,
  alias: string | null,
): boolean {
  if (!provider || !alias || run.provider !== provider) return false;
  return run.id === alias
    || run.logicalAgentId === alias
    || run.parentToolUseId === alias
    || run.identityAliases.includes(alias)
    || run.providerRunIds.includes(alias);
}

export function usageMetadata(
  usage: SubagentRunUsage | undefined,
  t: TFunction,
  options: { includeCost?: boolean } = {},
): string[] {
  const parts: string[] = [];
  const duration = formatDuration(usage?.durationMs);
  if (duration) parts.push(duration);
  if (typeof usage?.totalTokens === 'number' && usage.totalTokens > 0) {
    parts.push(
      t('rightSidebar.subagents.tokens', {
        value: formatCompactTokens(usage.totalTokens),
      }),
    );
  }
  if (typeof usage?.toolUses === 'number' && usage.toolUses > 0) {
    parts.push(t('rightSidebar.subagents.toolUses', { count: usage.toolUses }));
  }
  if (options.includeCost && typeof usage?.costUsd === 'number' && usage.costUsd > 0) {
    parts.push(usage.costUsd < 0.01 ? '<$0.01' : `$${usage.costUsd.toFixed(2)}`);
  }
  return parts;
}

export function metadata(run: SubagentRun, t: TFunction): string[] {
  return [
    providerLabel(run.provider),
    ...(run.model ? [run.model] : []),
    ...usageMetadata(run.usage, t, { includeCost: run.provider === 'pi' }),
  ];
}

export function childMetadata(child: SubagentChildRun, t: TFunction): string[] {
  return [
    child.role,
    ...(child.model ? [child.model] : []),
    ...(child.reasoningEffort ? [child.reasoningEffort] : []),
    ...usageMetadata(child.usage, t, { includeCost: true }),
  ];
}

export function childStatusLabel(child: SubagentChildRun, t: TFunction): string {
  if (child.awaitingApproval) return t('rightSidebar.subagents.awaitingApproval');
  if (child.status === 'queued') return t('rightSidebar.subagents.queued');
  return t(`chat.agentTask.status.${child.status}`);
}

export type SubagentErrorKind =
  | 'providerNotConnected'
  | 'credentialInvalid'
  | 'modelInvalid'
  | 'rateLimited'
  | 'serviceUnavailable'
  | 'requestInvalid'
  | 'unknown';

export function classifySubagentError(rawError: string): SubagentErrorKind {
  const value = rawError.toLowerCase();
  if (
    /invalid model|model[^\n]{0,80}(?:not found|unknown|unsupported|unavailable)|unknown[^\n]{0,40}model/.test(value)
  ) return 'modelInvalid';
  if (
    /(?:status(?:code)?\s*[:=]?\s*)?401\b|unauthori[sz]ed|invalid api[- ]?key|invalid[^\n]{0,40}token|token[^\n]{0,40}(?:expired|revoked)|credential[^\n]{0,40}(?:expired|invalid|revoked)/.test(value)
  ) return 'credentialInvalid';
  if (
    /provider[^\n]{0,60}(?:not connected|not configured|unavailable)|(?:missing|no)[^\n]{0,40}(?:credential|api[- ]?key|token)|authentication required|sign[- ]?in required|please[^\n]{0,40}(?:connect|sign in)/.test(value)
  ) return 'providerNotConnected';
  if (/(?:status(?:code)?\s*[:=]?\s*)?429\b|rate[- ]?limit|too many requests/.test(value)) {
    return 'rateLimited';
  }
  if (
    /(?:status(?:code)?\s*[:=]?\s*)?(?:500|502|503|504)\b|service unavailable|bad gateway|gateway timeout|temporarily unavailable/.test(value)
  ) return 'serviceUnavailable';
  if (/(?:status(?:code)?\s*[:=]?\s*)?400\b|bad request|invalid request/.test(value)) {
    return 'requestInvalid';
  }
  return 'unknown';
}

/** Wall-clock time for the technical log rows and card corners. */
export function formatClockTime(occurredAt: number): string | undefined {
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) return undefined;
  return new Date(occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const RELATIVE_UNITS: Array<{ limitMs: number; divisorMs: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { limitMs: 60_000, divisorMs: 1_000, unit: 'second' },
  { limitMs: 3_600_000, divisorMs: 60_000, unit: 'minute' },
  { limitMs: 86_400_000, divisorMs: 3_600_000, unit: 'hour' },
  { limitMs: 604_800_000, divisorMs: 86_400_000, unit: 'day' },
];

/**
 * Relative label for the list row corner. `Intl.RelativeTimeFormat` is used
 * deliberately instead of a new five-language key family: the platform already
 * owns the wording for every locale Cindy ships, and a hand-written set would
 * be one more copy surface to keep in sync (and improvised ja/ko copy is
 * forbidden by the i18n rules). Falls back to the clock time when the runtime
 * has no relative formatter.
 */
export function formatRelativeTimestamp(
  occurredAt: number,
  language: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) return undefined;
  const elapsed = now - occurredAt;
  try {
    const formatter = new Intl.RelativeTimeFormat(language || undefined, { numeric: 'auto' });
    for (const { limitMs, divisorMs, unit } of RELATIVE_UNITS) {
      if (Math.abs(elapsed) < limitMs) {
        return formatter.format(-Math.round(elapsed / divisorMs), unit);
      }
    }
    return formatter.format(-Math.round(elapsed / 604_800_000), 'week');
  } catch {
    return formatClockTime(occurredAt);
  }
}
