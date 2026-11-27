/**
 * pluginEngineQuota — Shared presentation logic for plugin-provided task engine quotas.
 *
 * Aligns plugin engine quota selection, ordering, and formatting across Desktop (status chip,
 * hover card, model picker rail/headers/rows) and Mobile (model picker headers/sources/rows,
 * session menu usage summary), for both local and remote devices.
 *
 * Zero React/Electron/Expo runtime dependencies.
 */
import { buildPluginEngineUsagePresentation } from './pluginEngineUsage';
import { quotaLevelFromRemaining, strongerQuotaLevel, type QuotaLevel } from './quotaLevel';

export interface PluginQuotaWindow {
  label: string;
  remainingPercent: number;
  /** Unix epoch milliseconds (GhostHarnessUsage convention). */
  resetsAt?: number;
  windowMinutes?: number;
  models?: readonly string[];
}

export interface PluginQuotaBalance {
  currency: string;
  amount: string;
}

export interface PluginQuotaSnapshot {
  updatedAt: number;
  windows?: readonly PluginQuotaWindow[];
  balances?: readonly PluginQuotaBalance[];
}

export interface PluginQuotaModelRef {
  id?: string | null;
  displayName?: string | null;
  group?: string | null;
}

export interface ParsedPluginQuotaWindowLabel {
  /** Group prefix before ` · <period>` when present (e.g. "Gemini Models"), else null. */
  groupName: string | null;
  /** Recognized period token (e.g. "5h", "weekly"), else null. */
  periodText: string | null;
  /** Inferred window length in minutes from periodText, if recognized. */
  inferredMinutes: number | null;
}

export interface SelectedPluginQuotaWindows {
  windows: PluginQuotaWindow[];
  /** True when the windows were narrowed to a specific model/group. */
  matchedModel: boolean;
  /** True when all reported windows belong to one group (no multi-group ambiguity). */
  singleGroup: boolean;
  /** Group name if all returned windows share one non-empty group prefix. */
  groupName: string | null;
}

export interface PluginEngineQuotaOverview {
  /** Primary window for rail bar & header summary (weekly preferred, else tightest live window). */
  primary: PluginQuotaWindow | null;
  /** Effective length in minutes of `primary`, if known. */
  primaryWindowMinutes: number | null;
  /** Tightest short window (<= 6h) for low/exhausted warnings. */
  shortWindow: PluginQuotaWindow | null;
  /** True when any live window is exhausted (remainingPercent <= 0). */
  limited: boolean;
  /** Recovery timestamp (epoch ms) when all exhausted windows carry a future resetsAt. */
  recoveryResetsAt: number | null;
  /** True when a short window is critically low (<= 10% left) without exhaustion. */
  shortLow: boolean;
  /** All unexpired windows ordered cleanly (group-preserving, short before long). */
  liveWindows: PluginQuotaWindow[];
  /** All expired windows. */
  expiredWindows: PluginQuotaWindow[];
}

export const PLUGIN_FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
export const PLUGIN_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

const SHORT_WINDOW_MAX_MINUTES = 6 * 60;
const WEEKLY_WINDOW_MIN_MINUTES = 6 * 24 * 60;
const WEEKLY_WINDOW_MAX_MINUTES = 8 * 24 * 60;
const MAX_WINDOW_MINUTES = 527_040;

const NAMED_PERIOD_MINUTES: Readonly<Record<string, number>> = {
  hour: 60,
  hourly: 60,
  day: 1440,
  daily: 1440,
  week: PLUGIN_WEEKLY_WINDOW_MINUTES,
  weekly: PLUGIN_WEEKLY_WINDOW_MINUTES,
};

const PERIOD_UNIT_MINUTES: Readonly<Record<string, number>> = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
  w: PLUGIN_WEEKLY_WINDOW_MINUTES,
  wk: PLUGIN_WEEKLY_WINDOW_MINUTES,
  week: PLUGIN_WEEKLY_WINDOW_MINUTES,
  weeks: PLUGIN_WEEKLY_WINDOW_MINUTES,
};

/** Generic descriptor words ignored when matching a model name against a quota group name. */
const GENERIC_GROUP_TOKENS = new Set([
  'model',
  'models',
  'and',
  'or',
  'the',
  'for',
  'of',
  'with',
  'via',
  'in',
  'on',
  'all',
  'other',
  'others',
  'default',
  'quota',
  'limit',
  'limits',
  'usage',
  'window',
  'remaining',
  'tier',
  'plan',
  'group',
  'pro',
  'flash',
  'mini',
  'nano',
  'lite',
  'fast',
  'max',
  'ultra',
  'oss',
  'preview',
  'latest',
  'beta',
  'alpha',
  'thinking',
  'reasoning',
  'chat',
  'code',
  'coding',
]);

export function clampPluginQuotaPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Matches Desktop TodaySpendChip `formatPercent` and `sessionControls.formatRateLimitPercent`:
 * integers within ±0.05 round cleanly; non-integers keep 1 decimal; 99.5%-99.94% never rounds
 * up to 100% (avoids falsely reporting a full/exhausted boundary).
 */
export function formatPluginQuotaPercent(value: number): string {
  const clamped = clampPluginQuotaPercent(value);
  if (clamped < 100 && clamped >= 99.5) {
    return `${(Math.floor(clamped * 10) / 10).toFixed(1)}%`;
  }
  if (Math.abs(clamped - Math.round(clamped)) < 0.05) return `${Math.round(clamped)}%`;
  return `${clamped.toFixed(1).replace(/\.0$/, '')}%`;
}

function parsePeriodMinutes(text: string): number | null {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_PERIOD_MINUTES, key)) {
    return NAMED_PERIOD_MINUTES[key]!;
  }
  const match = /^(\d{1,6})\s*([a-z]+)$/.exec(key);
  if (!match) return null;
  const unit = PERIOD_UNIT_MINUTES[match[2]!];
  if (!unit) return null;
  const minutes = unit * Number(match[1]);
  return minutes >= 1 && minutes <= MAX_WINDOW_MINUTES ? minutes : null;
}

/**
 * Splits labels like "Gemini Models · 5h" or "Claude and GPT models · weekly" into
 * `{ groupName, periodText, inferredMinutes }`. Plain period labels like "5h" or "weekly"
 * return `groupName: null`.
 */
export function parsePluginQuotaWindowLabel(label: string): ParsedPluginQuotaWindowLabel {
  const trimmed = label.trim();
  if (!trimmed) return { groupName: null, periodText: null, inferredMinutes: null };

  const directMinutes = parsePeriodMinutes(trimmed);
  if (directMinutes !== null) {
    return { groupName: null, periodText: trimmed, inferredMinutes: directMinutes };
  }

  const separatorIndex = trimmed.lastIndexOf(' · ');
  if (separatorIndex > 0) {
    const prefix = trimmed.slice(0, separatorIndex).trim();
    const suffix = trimmed.slice(separatorIndex + 3).trim();
    const suffixMinutes = parsePeriodMinutes(suffix);
    if (prefix && suffix && suffixMinutes !== null) {
      return {
        groupName: prefix,
        periodText: suffix,
        inferredMinutes: suffixMinutes,
      };
    }
  }

  return { groupName: null, periodText: null, inferredMinutes: null };
}

export function effectivePluginWindowMinutes(window: Pick<PluginQuotaWindow, 'label' | 'windowMinutes'>): number | null {
  if (typeof window.windowMinutes === 'number' && Number.isFinite(window.windowMinutes) && window.windowMinutes > 0) {
    return window.windowMinutes;
  }
  return parsePluginQuotaWindowLabel(window.label).inferredMinutes;
}

function isLiveWindow(window: PluginQuotaWindow, nowMs: number): boolean {
  return window.resetsAt === undefined || !Number.isFinite(window.resetsAt) || window.resetsAt > nowMs;
}

function compareByDurationAscending(a: PluginQuotaWindow, b: PluginQuotaWindow): number {
  const minA = effectivePluginWindowMinutes(a);
  const minB = effectivePluginWindowMinutes(b);
  if (minA !== null && minB !== null && minA !== minB) return minA - minB;
  if (minA !== null && minB === null) return -1;
  if (minA === null && minB !== null) return 1;
  const resetA = typeof a.resetsAt === 'number' && Number.isFinite(a.resetsAt) ? a.resetsAt : null;
  const resetB = typeof b.resetsAt === 'number' && Number.isFinite(b.resetsAt) ? b.resetsAt : null;
  if (resetA !== null && resetB !== null && resetA !== resetB) return resetA - resetB;
  return 0;
}

function sortByDurationAscending(windows: readonly PluginQuotaWindow[]): PluginQuotaWindow[] {
  return windows
    .map((window, index) => ({ window, index }))
    .sort((left, right) => compareByDurationAscending(left.window, right.window) || left.index - right.index)
    .map((entry) => entry.window);
}

function extractMatchingTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const parts = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const part of parts) {
    if (part.length < 2) continue;
    if (/^\d+$/.test(part)) continue;
    if (GENERIC_GROUP_TOKENS.has(part)) continue;
    tokens.add(part);
  }
  return tokens;
}

function matchGroupNameForModel(
  groupNames: readonly string[],
  model: PluginQuotaModelRef | null | undefined,
): string | null {
  if (!model) return null;
  const modelId = model.id?.trim() ?? '';
  const displayName = model.displayName?.trim() ?? '';
  const modelGroup = model.group?.trim() ?? '';
  if (!displayName && (!modelId || modelId === 'default') && !modelGroup) return null;

  if (modelGroup) {
    const exact = groupNames.find((name) => name.toLowerCase() === modelGroup.toLowerCase());
    if (exact) return exact;
  }

  const modelTokens = extractMatchingTokens(`${displayName} ${modelId === 'default' ? '' : modelId} ${modelGroup}`);
  if (modelTokens.size === 0) return null;

  let bestName: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const groupName of groupNames) {
    const groupTokens = extractMatchingTokens(groupName);
    let score = 0;
    for (const token of groupTokens) {
      if (modelTokens.has(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = groupName;
      tie = false;
    } else if (score > 0 && score === bestScore) {
      tie = true;
    }
  }
  return bestScore > 0 && !tie ? bestName : null;
}

function validWindows(windows: readonly PluginQuotaWindow[] | null | undefined): PluginQuotaWindow[] {
  return (windows ?? []).filter(
    (row) => typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent),
  );
}

/**
 * Selects the quota windows applicable to `model` and sorts them from shortest window to longest
 * (e.g. 5h before weekly, matching Claude / Codex / Kimi / GLM chips).
 *
 * Resolution order:
 * 1. Explicit `window.models` declarations (authoritative when present).
 * 2. Single-group snapshots (all windows apply to every model of the engine).
 * 3. Multi-group snapshots without `models` (e.g. Antigravity v0.5.0 reporting "Gemini Models" and
 *    "Claude and GPT models"): match by model group / family tokens so a Gemini task never shows
 *    Claude/GPT quota.
 * 4. Fallback when no model match is found:
 *    - `strictModelMatch: true` (per-model picker rows) returns empty to avoid attaching another
 *      group's quota to an unmatched model;
 *    - `strictModelMatch: false` (task status bar / menu) returns the most constrained group's
 *      complete window set so short + weekly windows stay paired.
 */
export function selectPluginWindowsForModel(
  rawWindows: readonly PluginQuotaWindow[] | null | undefined,
  model: PluginQuotaModelRef | null | undefined,
  nowMs: number,
  options?: { strictModelMatch?: boolean; includeExpired?: boolean },
): SelectedPluginQuotaWindows {
  const all = validWindows(rawWindows);
  if (all.length === 0) {
    return { windows: [], matchedModel: false, singleGroup: true, groupName: null };
  }
  const filterExpired = (rows: readonly PluginQuotaWindow[]): PluginQuotaWindow[] =>
    options?.includeExpired === false ? rows.filter((row) => isLiveWindow(row, nowMs)) : [...rows];

  const modelId = model?.id?.trim() ?? '';
  const hasExplicitModelScopes = all.some((row) => Array.isArray(row.models));
  if (hasExplicitModelScopes) {
    const shared = all.filter((row) => !Array.isArray(row.models));
    const scoped = modelId && modelId !== 'default'
      ? all.filter((row) => Array.isArray(row.models) && row.models.includes(modelId))
      : [];
    if (scoped.length > 0) {
      const combined = sortByDurationAscending(filterExpired([...shared, ...scoped]));
      const groupNames = new Set(
        scoped.map((row) => parsePluginQuotaWindowLabel(row.label).groupName).filter(Boolean),
      );
      return {
        windows: combined,
        matchedModel: true,
        singleGroup: false,
        groupName: groupNames.size === 1 ? [...groupNames][0]! : null,
      };
    }
    if (shared.length > 0) {
      return {
        windows: sortByDurationAscending(filterExpired(shared)),
        matchedModel: false,
        singleGroup: false,
        groupName: null,
      };
    }
    // Every window explicitly declares `models` and none includes this model.
    if (options?.strictModelMatch || (modelId && modelId !== 'default')) {
      return { windows: [], matchedModel: false, singleGroup: false, groupName: null };
    }
  }

  const byGroup = new Map<string, PluginQuotaWindow[]>();
  const ungrouped: PluginQuotaWindow[] = [];
  for (const row of all) {
    const group = parsePluginQuotaWindowLabel(row.label).groupName;
    if (group) {
      const bucket = byGroup.get(group);
      if (bucket) bucket.push(row);
      else byGroup.set(group, [row]);
    } else {
      ungrouped.push(row);
    }
  }

  const groupNames = [...byGroup.keys()];
  if (groupNames.length <= 1) {
    return {
      windows: sortByDurationAscending(filterExpired(all)),
      matchedModel: false,
      singleGroup: true,
      groupName: groupNames[0] ?? null,
    };
  }

  const matchedGroup = matchGroupNameForModel(groupNames, model);
  if (matchedGroup) {
    return {
      windows: sortByDurationAscending(filterExpired([...ungrouped, ...(byGroup.get(matchedGroup) ?? [])])),
      matchedModel: true,
      singleGroup: false,
      groupName: matchedGroup,
    };
  }

  if (options?.strictModelMatch) {
    return {
      windows: ungrouped.length > 0 ? sortByDurationAscending(filterExpired(ungrouped)) : [],
      matchedModel: false,
      singleGroup: false,
      groupName: null,
    };
  }

  // Fallback for status surfaces when no model matched: pick the group containing the tightest live
  // window (or tightest window overall if all are expired/pending) so paired windows stay together.
  const pickTightest = (list: readonly PluginQuotaWindow[]) =>
    list.reduce<PluginQuotaWindow | undefined>(
      (lowest, row) => (!lowest || row.remainingPercent < lowest.remainingPercent ? row : lowest),
      undefined,
    );
  const live = all.filter((row) => isLiveWindow(row, nowMs));
  const tightest = pickTightest(live.length > 0 ? live : all);
  const tightestGroup = tightest ? parsePluginQuotaWindowLabel(tightest.label).groupName : null;
  if (tightestGroup && byGroup.has(tightestGroup)) {
    return {
      windows: sortByDurationAscending(filterExpired([...ungrouped, ...(byGroup.get(tightestGroup) ?? [])])),
      matchedModel: false,
      singleGroup: false,
      groupName: tightestGroup,
    };
  }
  return {
    windows: sortByDurationAscending(filterExpired(all)),
    matchedModel: false,
    singleGroup: false,
    groupName: null,
  };
}

/**
 * Orders all windows for a full usage card (Desktop QuotaHoverCard / Settings):
 * keeps every group visible, places the active model's group first, and orders each group
 * from shortest window to longest (e.g. 5h then weekly).
 */
export function orderPluginUsageCardWindows(
  rawWindows: readonly PluginQuotaWindow[] | null | undefined,
  model?: PluginQuotaModelRef | null,
): PluginQuotaWindow[] {
  const all = validWindows(rawWindows);
  if (all.length <= 1) return all;

  const modelId = model?.id?.trim() ?? '';
  const groups: Array<{ key: string; rows: PluginQuotaWindow[]; priority: number }> = [];
  const groupIndex = new Map<string, number>();

  for (const row of all) {
    const parsed = parsePluginQuotaWindowLabel(row.label);
    const key = parsed.groupName ?? '';
    let idx = groupIndex.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groupIndex.set(key, idx);
      groups.push({ key, rows: [], priority: 1 });
    }
    groups[idx]!.rows.push(row);
  }

  const matchedGroupName = matchGroupNameForModel(
    groups.map((group) => group.key).filter(Boolean),
    model,
  );

  for (const group of groups) {
    const explicitHit = Boolean(
      modelId && modelId !== 'default' && group.rows.some((row) => row.models?.includes(modelId)),
    );
    const nameHit = Boolean(matchedGroupName && group.key === matchedGroupName);
    if (explicitHit || nameHit || group.key === '') {
      group.priority = 0;
    }
  }

  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => a.group.priority - b.group.priority || a.index - b.index)
    .flatMap(({ group }) => sortByDurationAscending(group.rows));
}

function isWeeklyWindow(window: PluginQuotaWindow): boolean {
  const minutes = effectivePluginWindowMinutes(window);
  return minutes !== null && minutes >= WEEKLY_WINDOW_MIN_MINUTES && minutes <= WEEKLY_WINDOW_MAX_MINUTES;
}

function isShortWindow(window: PluginQuotaWindow): boolean {
  const minutes = effectivePluginWindowMinutes(window);
  return minutes !== null && minutes <= SHORT_WINDOW_MAX_MINUTES;
}

function pickTightestWindow(windows: readonly PluginQuotaWindow[]): PluginQuotaWindow | null {
  return windows.reduce<PluginQuotaWindow | null>((lowest, row) => {
    if (!lowest) return row;
    if (row.remainingPercent !== lowest.remainingPercent) {
      return row.remainingPercent < lowest.remainingPercent ? row : lowest;
    }
    const resetRow = row.resetsAt ?? Number.POSITIVE_INFINITY;
    const resetLowest = lowest.resetsAt ?? Number.POSITIVE_INFINITY;
    return resetRow < resetLowest ? row : lowest;
  }, null);
}

/**
 * Engine-level overview used by Desktop rail bars, Desktop/Mobile group headers, and Mobile
 * Sources rows. Prefers weekly windows (matching built-in Claude/Codex/xAI weekly quota bars),
 * falling back to the tightest live window when an engine only reports non-weekly windows.
 */
export function pickPluginEngineWeeklyQuota(
  usage: PluginQuotaSnapshot | null | undefined,
  nowMs: number,
): PluginEngineQuotaOverview {
  const ordered = orderPluginUsageCardWindows(usage?.windows);
  const liveWindows: PluginQuotaWindow[] = [];
  const expiredWindows: PluginQuotaWindow[] = [];
  for (const row of ordered) {
    if (isLiveWindow(row, nowMs)) liveWindows.push(row);
    else expiredWindows.push(row);
  }

  const weeklyLive = liveWindows.filter(isWeeklyWindow);
  const primary = pickTightestWindow(weeklyLive.length > 0 ? weeklyLive : liveWindows);
  const shortWindow = pickTightestWindow(liveWindows.filter(isShortWindow));
  const exhausted = liveWindows.filter((row) => row.remainingPercent <= 0);
  const limited = exhausted.length > 0;
  const recoveryResetsAt =
    limited && exhausted.every((row) => typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt) && row.resetsAt > 0)
      ? Math.max(...exhausted.map((row) => row.resetsAt!))
      : null;
  const shortLow = !limited && shortWindow !== null && shortWindow.remainingPercent <= 10;

  return {
    primary,
    primaryWindowMinutes: primary ? effectivePluginWindowMinutes(primary) : null,
    shortWindow,
    limited,
    recoveryResetsAt,
    shortLow,
    liveWindows,
    expiredWindows,
  };
}

/**
 * Picks the single representative quota window for a model row in the model picker:
 * - `prefer: 'tightest'` (Desktop ModelSourceDetails): tightest live window across the model's
 *   applicable windows (e.g. 5h vs weekly, matching Claude/Codex in Desktop's model picker).
 * - `prefer: 'weekly'` (Mobile model rows): weekly window when present, else tightest live window
 *   (matching Mobile's `modelQuotaLabel` / `mobileWeeklyQuota`).
 */
export function pickPluginModelPickerWindow(
  usage: PluginQuotaSnapshot | null | undefined,
  model: PluginQuotaModelRef | null | undefined,
  nowMs: number,
  options?: { prefer?: 'tightest' | 'weekly'; includeExpired?: boolean },
): {
  primary: PluginQuotaWindow | null;
  windows: PluginQuotaWindow[];
} {
  if (!usage?.windows?.length) return { primary: null, windows: [] };
  const selected = selectPluginWindowsForModel(usage.windows, model, nowMs, {
    strictModelMatch: true,
    includeExpired: options?.includeExpired ?? false,
  });
  if (selected.windows.length === 0) return { primary: null, windows: [] };

  const live = selected.windows.filter((row) => isLiveWindow(row, nowMs));
  const pool = live.length > 0 ? live : selected.windows;

  if (options?.prefer === 'weekly') {
    const weekly = pool.filter(isWeeklyWindow);
    const chosen = pickTightestWindow(weekly.length > 0 ? weekly : pool);
    return { primary: chosen, windows: selected.windows };
  }

  // Tightest live window; on ties prefer the later (longer) window, matching ModelSourceDetails.
  const tightest = pool.reduce<PluginQuotaWindow | null>((best, row) => {
    if (!best) return row;
    return row.remainingPercent <= best.remainingPercent ? row : best;
  }, null);
  return { primary: tightest, windows: selected.windows };
}

export interface PluginEngineQuotaPool {
  /** Stable pool id within the snapshot (same as `PluginEngineQuotaGroup.id`). */
  id: string;
  /** Compact pool label for narrow headers (e.g. "Gemini", "Claude & GPT"). */
  label: string;
  /** Original pool name reported by the plugin (e.g. "Gemini Models"), if any. */
  rawName: string | null;
  /** The pool's own weekly-first overview: never mixed with another pool's windows. */
  overview: PluginEngineQuotaOverview;
  /** Rounded remaining percent of `overview.primary`. */
  remaining: number;
  /** Severity: exhausted → crit, 5h critically low → at least warn, else from `remaining`. */
  level: QuotaLevel;
}

/**
 * Per-pool header readouts for engines that meter independent model pools in one snapshot
 * (Antigravity: "Gemini Models" vs "Claude and GPT models"). Each pool follows the same
 * weekly-first rules as `pickPluginEngineWeeklyQuota`, but only over its own windows, so a
 * Gemini pool never shows Claude/GPT quota. Returns null for single-pool engines, which keep
 * the single weekly summary.
 */
export function pickPluginEngineQuotaPools(
  usage: PluginQuotaSnapshot | null | undefined,
  nowMs: number,
): PluginEngineQuotaPool[] | null {
  if (!usage) return null;
  const presentation = buildPluginEngineUsagePresentation(usage, nowMs);
  if (!presentation.isMultiGroup || presentation.groups.length === 0) return null;
  const pools: PluginEngineQuotaPool[] = [];
  for (const group of presentation.groups) {
    const overview = pickPluginEngineWeeklyQuota({ ...usage, windows: group.windows }, nowMs);
    if (!overview.primary) continue;
    const remaining = Math.round(clampPluginQuotaPercent(overview.primary.remainingPercent));
    const level: QuotaLevel = overview.limited
      ? 'crit'
      : strongerQuotaLevel(quotaLevelFromRemaining(remaining), overview.shortLow ? 'warn' : 'normal');
    pools.push({
      id: group.id,
      label: group.shortLabel || group.rawName || overview.primary.label,
      rawName: group.rawName,
      overview,
      remaining,
      level,
    });
  }
  return pools.length > 0 ? pools : null;
}
