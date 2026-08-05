/**
 * diffStats
 * ---------------------------------------------------------------------------
 * F2 — compute "+N -N" line counts for Edit / Write / MultiEdit per ADR-5.
 *
 * Why three tools (D1 / ADR-5):
 *   - Edit       → diff old_string vs new_string → real +N -N
 *   - Write      → diff "" vs content            → +N -0 (every line is new)
 *   - MultiEdit  → sum of diffs across edits[]    → single combined +N -N
 *   - other tools → null → row hides the number cluster
 *
 * Backed by the same `diff` package that DiffView already uses, so the
 * counts here line up exactly with the diff body the user can expand.
 */

import { diffLines } from 'diff';

export interface DiffStat {
  add: number;
  del: number;
}

/**
 * Count line-level additions and deletions between two strings.
 * Trailing newline on a chunk is stripped before counting so a file ending
 * in `\n` doesn't get billed an extra phantom line.
 */
export function computeDiffStats(oldStr: string, newStr: string): DiffStat {
  let add = 0;
  let del = 0;
  const changes = diffLines(oldStr, newStr);
  for (const c of changes) {
    if (!c.added && !c.removed) continue;
    const trimmed = c.value.replace(/\n$/, '');
    // Empty chunk shouldn't count any lines (trimmed === '' → split → ['']).
    const lineCount = trimmed === '' ? 0 : trimmed.split('\n').length;
    if (c.added) add += lineCount;
    else if (c.removed) del += lineCount;
  }
  return { add, del };
}

/** Count additions/deletions in an already-materialized unified diff. */
export function computeUnifiedDiffStats(raw: string): DiffStat | null {
  let add = 0;
  let del = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return add > 0 || del > 0 ? { add, del } : null;
}

/**
 * Resolve diff stats from a tool-call (toolName + toolInput).
 * Returns null for tools without a meaningful diff (everything except
 * Edit / Write / MultiEdit), letting AgentActionRow skip the number block.
 */
export function statsForToolCall(
  toolName: string,
  toolInput: unknown,
): DiffStat | null {
  const inp = toolInput as Record<string, unknown> | null;
  if (!inp) return null;

  if (toolName === 'Edit') {
    const o = typeof inp.old_string === 'string' ? inp.old_string : '';
    const n = typeof inp.new_string === 'string' ? inp.new_string : '';
    return computeDiffStats(o, n);
  }

  if (toolName === 'Write') {
    const c = typeof inp.content === 'string' ? inp.content : '';
    // All-add: oldStr = ''. Surface as `+N -0` per ADR-5.
    return computeDiffStats('', c);
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    let add = 0;
    let del = 0;
    for (const e of edits) {
      const er = e as Record<string, unknown> | null;
      const o =
        er && typeof er.old_string === 'string' ? (er.old_string as string) : '';
      const n =
        er && typeof er.new_string === 'string' ? (er.new_string as string) : '';
      const s = computeDiffStats(o, n);
      add += s.add;
      del += s.del;
    }
    return { add, del };
  }

  if (toolName === 'file_change') {
    const changes = Array.isArray(inp.changes) ? inp.changes : [];
    let add = 0;
    let del = 0;
    let hasDiff = false;
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const diff = (change as Record<string, unknown>).diff;
      if (typeof diff !== 'string') continue;
      const stats = computeUnifiedDiffStats(diff);
      if (!stats) continue;
      hasDiff = true;
      add += stats.add;
      del += stats.del;
    }
    return hasDiff ? { add, del } : null;
  }

  return null;
}
