import {
  AT_MENTION_SEARCH_RESULT_LIMIT,
  scoreAtResourceItem,
  type AtResourceItem,
} from './atResourceService';

/**
 * Unified composer suggestion layer — the union of the legacy `@` mention
 * panel (resources) and the legacy `+` MorphPopover menu (actions).
 *
 * Following Codex Desktop's pattern, the `+` button synthetically opens the
 * same panel that typing `@` opens; action rows (attach files, new goal,
 * plan mode, collaboration, add reference directory) live in the same list
 * as scanned resources and are filtered by the same query.
 *
 * Pure TS, no React. ChatInput assembles the inputs; AtMentionPanel renders
 * the resulting entry list. Keyboard focus indexes into the returned array,
 * so the assembly order here IS the visual order.
 */

export type ComposerSuggestionActionId =
  | 'attach-files'
  | 'capture-region'
  | 'new-goal'
  | 'plan-mode'
  | 'collaboration'
  | 'add-extra-dir'
  | 'add-writable-dir';

export interface ComposerSuggestionAction {
  id: ComposerSuggestionActionId;
  /** Resolved display label (already i18n'd) — also the query match target. */
  label: string;
  /** Extra text matched by the query besides the label (e.g. English alias). */
  searchText?: string;
  /** menuitemcheckbox state (plan mode / collaboration). Absent = plain action. */
  checked?: boolean;
  disabled?: boolean;
  /** Shown as a row tooltip when the action is disabled (e.g. collab policy). */
  disabledReason?: string;
  run: () => void;
}

export type ComposerSuggestionEntry =
  | {
      kind: 'resource';
      item: AtResourceItem;
      /** Plugin rows without a usable command stay visible but unselectable. */
      disabled?: boolean;
      disabledReason?: string;
    }
  | { kind: 'action'; action: ComposerSuggestionAction };

/** Plugin rows carry entry-level availability on top of the resource item. */
export interface ComposerPluginSuggestion {
  item: AtResourceItem;
  disabled?: boolean;
  disabledReason?: string;
}

export type ComposerAtActivation =
  | { activation: 'typed'; from: number; query: string }
  | { activation: 'synthetic'; from: number; query: string };

/**
 * Resolve the shared panel activation. A synthetic `+` open is explicit and
 * therefore owns the panel until its anchor becomes invalid, even when text
 * before the caret still happens to match a typed `@` run.
 */
export function resolveComposerAtActivation({
  typed,
  syntheticAnchor,
  syntheticQuery,
}: {
  typed: { from: number; query: string } | null;
  syntheticAnchor: number | null;
  syntheticQuery: string | null;
}): ComposerAtActivation | null {
  if (syntheticAnchor !== null && syntheticQuery !== null) {
    return { activation: 'synthetic', from: syntheticAnchor, query: syntheticQuery };
  }
  return typed ? { activation: 'typed', ...typed } : null;
}

/** Per-section caps on the empty-query view (tabs / agents only — plugins
 *  render in full like the legacy `+` menu did; the panel scrolls). */
export const EMPTY_QUERY_CONTEXT_SECTION_LIMIT = 3;

export function composerSuggestionEntryKey(entry: ComposerSuggestionEntry): string {
  return entry.kind === 'action'
    ? `action:${entry.action.id}`
    : `resource:${entry.item.type}:${entry.item.pluginId ?? ''}:${entry.item.relPath}`;
}

export function isComposerSuggestionEntryDisabled(entry: ComposerSuggestionEntry): boolean {
  return entry.kind === 'action' ? entry.action.disabled === true : entry.disabled === true;
}

/**
 * Move focus by `delta` (+1 / -1) with wraparound, skipping disabled entries.
 * Returns `current` unchanged when every entry is disabled or the list is empty.
 */
export function nextEnabledSuggestionIndex(
  entries: readonly ComposerSuggestionEntry[],
  current: number,
  delta: 1 | -1,
): number {
  if (entries.length === 0) return current;
  let i = current;
  for (let step = 0; step < entries.length; step++) {
    i = (i + delta + entries.length) % entries.length;
    if (!isComposerSuggestionEntryDisabled(entries[i])) return i;
  }
  return current;
}

/** First enabled index, or 0 when nothing is enabled/present. */
export function firstEnabledSuggestionIndex(
  entries: readonly ComposerSuggestionEntry[],
): number {
  const idx = entries.findIndex((entry) => !isComposerSuggestionEntryDisabled(entry));
  return idx >= 0 ? idx : 0;
}

function scoreAction(action: ComposerSuggestionAction, q: string): number {
  // Reuse the resource scorer verbatim so actions and resources rank in one
  // comparable pool (label ≙ name, searchText ≙ relPath).
  return scoreAtResourceItem(
    {
      type: 'file',
      name: action.label,
      relPath: action.searchText ?? '',
      _nameLower: action.label.toLowerCase(),
      _relPathLower: (action.searchText ?? '').toLowerCase(),
    },
    q,
  );
}

interface BuildComposerSuggestionEntriesInput {
  /** Trimmed-or-not raw query; empty string = curated sections view. */
  query: string;
  /** Ordered action list assembled by ChatInput (attach → goal → plan → collab → add-dir). */
  actions: readonly ComposerSuggestionAction[];
  /** Scanned mention resources (workspace/context/task/plugin resources). */
  resources: readonly AtResourceItem[];
  /** Installed plugins incl. unavailable ones (disabled rows, `+`-menu parity). */
  plugins: readonly ComposerPluginSuggestion[];
}

/**
 * Empty query — curated sections, in visual order:
 *   1. attach-files action
 *   2. remaining actions except add-extra-dir (goal / plan mode / collaboration)
 *   3. browser tabs (≤3), agents (≤3)
 *   4. all plugins (unavailable ones disabled)
 *   5. add-extra-dir action (rendered under the reference-dirs section)
 *
 * Non-empty query — one flat pool ranked by the shared scorer, capped to
 * `AT_MENTION_SEARCH_RESULT_LIMIT`. Disabled plugins are excluded from search
 * results; workspace files/directories are searched directly.
 */
export function buildComposerSuggestionEntries(
  input: BuildComposerSuggestionEntriesInput,
): ComposerSuggestionEntry[] {
  const q = input.query.trim().toLowerCase();
  if (!q) {
    const entries: ComposerSuggestionEntry[] = [];
    const attach = input.actions.find((a) => a.id === 'attach-files');
    if (attach) entries.push({ kind: 'action', action: attach });
    for (const action of input.actions) {
      if (
        action.id === 'attach-files'
        || action.id === 'add-extra-dir'
        || action.id === 'add-writable-dir'
      ) continue;
      entries.push({ kind: 'action', action });
    }
    for (const type of ['browser-tab', 'agent'] as const) {
      let count = 0;
      for (const item of input.resources) {
        if (item.type !== type) continue;
        entries.push({ kind: 'resource', item });
        count += 1;
        if (count >= EMPTY_QUERY_CONTEXT_SECTION_LIMIT) break;
      }
    }
    for (const plugin of input.plugins) {
      entries.push({
        kind: 'resource',
        item: plugin.item,
        ...(plugin.disabled ? { disabled: true } : {}),
        ...(plugin.disabledReason ? { disabledReason: plugin.disabledReason } : {}),
      });
    }
    const addDir = input.actions.find((a) => a.id === 'add-extra-dir');
    if (addDir) entries.push({ kind: 'action', action: addDir });
    const addWritableDir = input.actions.find((a) => a.id === 'add-writable-dir');
    if (addWritableDir) entries.push({ kind: 'action', action: addWritableDir });
    return entries;
  }

  const scored: Array<{ entry: ComposerSuggestionEntry; score: number; label: string }> = [];
  for (const action of input.actions) {
    if (action.disabled) continue;
    const s = scoreAction(action, q);
    if (s >= 0) scored.push({ entry: { kind: 'action', action }, score: s, label: action.label });
  }
  for (const item of input.resources) {
    const s = scoreAtResourceItem(item, q);
    if (s >= 0) scored.push({ entry: { kind: 'resource', item }, score: s, label: item.name });
  }
  for (const plugin of input.plugins) {
    if (plugin.disabled) continue;
    const s = scoreAtResourceItem(plugin.item, q);
    if (s >= 0) {
      scored.push({
        entry: { kind: 'resource', item: plugin.item },
        score: s,
        label: plugin.item.name,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  if (scored.length > AT_MENTION_SEARCH_RESULT_LIMIT) {
    scored.length = AT_MENTION_SEARCH_RESULT_LIMIT;
  }
  return scored.map((s) => s.entry);
}
