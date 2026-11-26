/**
 * Grouping and summary rules for plugin engine account usage (`GhostHarnessUsage`),
 * shared by Desktop and Mobile model pickers.
 *
 * Some engines meter independent model pools in one usage snapshot — notably Antigravity,
 * whose `/usage` reports separate windows for `"Gemini Models"` (weekly / 5h) and
 * `"Claude and GPT models"` (weekly / 5h). Grouping preserves each pool independently so
 * callers can render one progress bar per pool instead of collapsing them into a single
 * engine-wide number.
 */
import { quotaLevelFromRemaining, strongerQuotaLevel, type QuotaLevel } from './quotaLevel';

export interface PluginEngineUsageWindowInput {
  label: string;
  remainingPercent: number;
  resetsAt?: number;
  windowMinutes?: number;
  models?: readonly string[];
}

export interface PluginEngineUsageBalanceInput {
  currency: string;
  amount: string;
}

export interface PluginEngineUsageInput {
  updatedAt: number;
  windows?: readonly PluginEngineUsageWindowInput[];
  balances?: readonly PluginEngineUsageBalanceInput[];
}

export interface PluginEngineQuotaGroup {
  /** Stable identifier within the snapshot (lowercase label prefix, model set, or `'default'`). */
  id: string;
  /** Original group prefix parsed from `"<Group> · <period>"` (null when ungrouped). */
  rawName: string | null;
  /** Compact display label for narrow picker headers (e.g. `"Gemini"`, `"Claude & GPT"`). */
  shortLabel: string | null;
  /** Binding (tightest unexpired) window representing this group's current remaining quota. */
  primary: PluginEngineUsageWindowInput;
  /** Rounded remaining percentage (0..100) of `primary`. */
  remainingPercent: number;
  /** Quota severity level of `primary` (<=30% warn, <=10% crit, else normal). */
  level: QuotaLevel;
  /** All unexpired windows belonging to this group, preserving upstream order. */
  windows: PluginEngineUsageWindowInput[];
}

export interface PluginEngineQuotaBalance {
  currency: string;
  amount: string;
  numericAmount: number;
}

export interface PluginEngineUsagePresentation {
  /** Live quota groups in upstream first-seen order. */
  groups: PluginEngineQuotaGroup[];
  /**
   * Single tightest live group across all groups (for compact single-bar surfaces like the
   * source rail icon). Null when no live window exists.
   */
  primaryGroup: PluginEngineQuotaGroup | null;
  /**
   * True when the snapshot declares 2+ distinct quota groups (even if one group's windows
   * temporarily expired awaiting refresh), so surviving groups keep their group labels.
   */
  isMultiGroup: boolean;
  /** Strongest quota level across all live groups (or depleted balance). */
  level: QuotaLevel;
  /** Valid numeric currency balances reported by the plugin. */
  balances: PluginEngineQuotaBalance[];
}

/** Splits `"<Group> · <period>"` into group name and period; returns `{ group: null }` otherwise. */
export function splitPluginUsageWindowLabel(label: string): { group: string | null; period: string } {
  const sep = label.indexOf(' · ');
  if (sep > 0) {
    const group = label.slice(0, sep).trim();
    const period = label.slice(sep + 3).trim();
    if (group && period) return { group, period };
  }
  return { group: null, period: label.trim() };
}

/**
 * Shortens an upstream quota group name for tight picker rows without inventing brand names:
 * `"Gemini Models"` → `"Gemini"`, `"Claude and GPT models"` → `"Claude & GPT"`.
 */
export function compactPluginUsageGroupLabel(rawGroup: string): string {
  const trimmed = rawGroup.trim();
  const withoutModels = trimmed.replace(/\s+models?$/i, '').trim();
  const base = withoutModels || trimmed;
  return base.replace(/\s+and\s+/gi, ' & ');
}

function groupIdentityOf(window: PluginEngineUsageWindowInput): { id: string; rawName: string | null } {
  const { group } = splitPluginUsageWindowLabel(window.label);
  if (group !== null) {
    return { id: `label:${group.toLowerCase()}`, rawName: group };
  }
  if (window.models && window.models.length > 0) {
    const sorted = [...window.models].sort();
    return { id: `models:${sorted.join('\0')}`, rawName: window.label.trim() || null };
  }
  return { id: 'default', rawName: null };
}

function isBetterPrimary(
  candidate: PluginEngineUsageWindowInput,
  current: PluginEngineUsageWindowInput,
): boolean {
  if (candidate.remainingPercent !== current.remainingPercent) {
    return candidate.remainingPercent < current.remainingPercent;
  }
  const candidateHasReset = typeof candidate.resetsAt === 'number' && candidate.resetsAt > 0;
  const currentHasReset = typeof current.resetsAt === 'number' && current.resetsAt > 0;
  if (candidateHasReset !== currentHasReset) return candidateHasReset;
  if (!candidateHasReset || !currentHasReset) return false;
  // When both windows are exhausted (0% left), the later reset is the actual blocker.
  if (candidate.remainingPercent <= 0) {
    return candidate.resetsAt! > current.resetsAt!;
  }
  return candidate.resetsAt! < current.resetsAt!;
}

function pickPrimaryWindow(windows: readonly PluginEngineUsageWindowInput[]): PluginEngineUsageWindowInput {
  let best = windows[0]!;
  for (let index = 1; index < windows.length; index += 1) {
    const candidate = windows[index]!;
    if (isBetterPrimary(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Normalizes a plugin engine's usage snapshot into independent quota groups and balances
 * as of `nowMs`. Expired windows (`resetsAt <= nowMs`) are excluded from live bars.
 */
export function buildPluginEngineUsagePresentation(
  usage: PluginEngineUsageInput | null | undefined,
  nowMs: number,
): PluginEngineUsagePresentation {
  if (!usage) {
    return { groups: [], primaryGroup: null, isMultiGroup: false, level: 'normal', balances: [] };
  }

  const balances: PluginEngineQuotaBalance[] = [];
  for (const row of usage.balances ?? []) {
    const numericAmount = Number(row.amount);
    if (typeof row.currency === 'string' && Number.isFinite(numericAmount)) {
      balances.push({ currency: row.currency, amount: row.amount, numericAmount });
    }
  }

  const allGroupIds = new Set<string>();
  const liveByGroup = new Map<string, { rawName: string | null; windows: PluginEngineUsageWindowInput[] }>();

  for (const row of usage.windows ?? []) {
    if (!Number.isFinite(row.remainingPercent)) continue;
    const identity = groupIdentityOf(row);
    allGroupIds.add(identity.id);
    if (typeof row.resetsAt === 'number' && row.resetsAt <= nowMs) continue;
    let bucket = liveByGroup.get(identity.id);
    if (!bucket) {
      bucket = { rawName: identity.rawName, windows: [] };
      liveByGroup.set(identity.id, bucket);
    }
    bucket.windows.push(row);
  }

  const groups: PluginEngineQuotaGroup[] = [];
  for (const [id, bucket] of liveByGroup) {
    const primary = pickPrimaryWindow(bucket.windows);
    const clamped = Math.max(0, Math.min(100, primary.remainingPercent));
    groups.push({
      id,
      rawName: bucket.rawName,
      shortLabel: bucket.rawName ? compactPluginUsageGroupLabel(bucket.rawName) : null,
      primary,
      remainingPercent: Math.round(clamped),
      level: quotaLevelFromRemaining(clamped),
      windows: bucket.windows,
    });
  }

  let primaryGroup: PluginEngineQuotaGroup | null = null;
  for (const group of groups) {
    if (!primaryGroup || isBetterPrimary(group.primary, primaryGroup.primary)) {
      primaryGroup = group;
    }
  }

  const level: QuotaLevel = groups.length > 0
    ? strongerQuotaLevel(...groups.map((group) => group.level))
    : balances[0] && balances[0].numericAmount <= 0
      ? 'crit'
      : 'normal';

  return {
    groups,
    primaryGroup,
    isMultiGroup: allGroupIds.size > 1,
    level,
    balances,
  };
}

const GENERIC_GROUP_WORDS = new Set([
  'model',
  'models',
  'and',
  'or',
  'other',
  'others',
  'all',
  'the',
  'for',
  'pool',
  'quota',
  'usage',
  'limit',
  'limits',
]);

function tokenizeLower(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function groupFamilyTokens(group: PluginEngineQuotaGroup): string[] {
  const source = group.shortLabel ?? group.rawName ?? '';
  return tokenizeLower(source).filter((token) => token.length >= 2 && !GENERIC_GROUP_WORDS.has(token));
}

function isCatchAllOtherGroup(group: PluginEngineQuotaGroup): boolean {
  const tokens = tokenizeLower(group.shortLabel ?? group.rawName ?? '');
  return tokens.includes('other') || tokens.includes('others');
}

/**
 * Matches a plugin engine model row to its governing quota group (e.g. `gemini-4-neon` →
 * `Gemini Models`, `claude-sonnet-5-5` / `gpt-oss-120b-medium` → `Claude and GPT models`).
 * Returns null when a multi-group snapshot cannot be matched unambiguously.
 */
export function matchPluginEngineQuotaGroup(
  presentation: PluginEngineUsagePresentation | null | undefined,
  model: { id: string; name?: string | null },
): PluginEngineQuotaGroup | null {
  if (!presentation || presentation.groups.length === 0) return null;
  if (!presentation.isMultiGroup) return presentation.groups[0] ?? null;

  const modelIdLower = model.id.trim().toLowerCase();
  if (modelIdLower) {
    const explicit = presentation.groups.filter((group) =>
      group.windows.some((window) =>
        window.models?.some((candidate) => candidate.trim().toLowerCase() === modelIdLower),
      ),
    );
    if (explicit.length === 1) return explicit[0]!;
    if (explicit.length > 1) return null;
  }

  const modelTokens = new Set([
    ...tokenizeLower(model.id),
    ...(model.name ? tokenizeLower(model.name) : []),
  ]);
  if (modelTokens.size > 0) {
    const familyMatches = presentation.groups.filter((group) =>
      groupFamilyTokens(group).some((token) => modelTokens.has(token)),
    );
    if (familyMatches.length === 1) return familyMatches[0]!;
    if (familyMatches.length > 1) return null;
  }

  const catchAll = presentation.groups.filter(isCatchAllOtherGroup);
  return catchAll.length === 1 ? catchAll[0]! : null;
}

/**
 * Stable string key of time-dependent display fields for a usage snapshot, so local
 * display clocks only trigger a React re-render when a window expires or a countdown changes.
 */
export function pluginEngineUsageClockKey(
  usage: PluginEngineUsageInput | null | undefined,
  nowMs: number,
  formatReset: (resetsAtMs: number, nowMs: number) => string | null,
): string {
  if (!usage?.windows?.length) return '';
  return usage.windows
    .filter((row) => Number.isFinite(row.remainingPercent) && (!row.resetsAt || row.resetsAt > nowMs))
    .map((row) => [
      row.label,
      Math.round(row.remainingPercent),
      row.resetsAt ? formatReset(row.resetsAt, nowMs) : null,
    ].join(':'))
    .join('|');
}
