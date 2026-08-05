import { createLogger } from '@/lib/logger';

const log = createLogger('AtResourceService');
/**
 * @-mention resource data layer — command-palette F2 / F5.
 *
 * Responsibilities:
 *   - Call maker → BaseAgent resource scanning and shape results into `AtResourceItem`.
 *   - Fuzzy-match + rank items against the user's query (what the user typed
 *     after the `@` trigger character).
 *   - Handle name conflicts (agent vs file with same name → agent wins).
 *
 * This module is pure TS, no React. The panel component consumes it.
 */

export type AtResourceType = 'file' | 'dir' | 'agent';

export interface AtResourceItem {
  type: AtResourceType;
  /** Display name:
   *  - file → basename with extension
   *  - dir  → basename (no trailing slash; UI adds it for visual hint)
   *  - agent → filename without `.md`
   */
  name: string;
  /** workingDir-relative path, POSIX style. Used for:
   *  - display "apps/server/src/routes" (minus basename) in right column
   *  - serialization on submit: `@relPath` / `@relPath/` / `@.claude/agents/<name>.md`
   */
  relPath: string;
  /** Agent description from YAML frontmatter (agents only). */
  description?: string;
  /** @internal Pre-computed lowercase for filter performance. */
  _nameLower?: string;
  /** @internal Pre-computed lowercase for filter performance. */
  _relPathLower?: string;
}

export interface ScanResult {
  success: boolean;
  error?: string;
  items: AtResourceItem[];
  truncated: boolean;
}

export type PaletteAgentKind = 'claude-code' | 'codex';

/**
 * Load candidate @-resources from the active agent/workspace. Returns `success:false`
 * when workingDir is missing or IPC fails; panel should render the error
 * state with a retry action in that case.
 *
 * De-dup rule (F5 spec): when an agent and a file share the same `name`,
 * the agent wins. This is extremely rare in practice but we log a warning
 * as the spec requires.
 */
export async function scanAtResources(
  workingDir: string,
  agentKind: PaletteAgentKind,
  cap = 2000,
  query?: string,
  /**
   * device-link 远程会话:传被控设备 deviceId → 经隧道在**被控端**扫描其文件
   * (workingDir 是被控端路径)。不传 = 本机扫描。channel 与本地完全一致,被控端跑同一 handler。
   */
  deviceId?: string,
): Promise<ScanResult> {
  if (!workingDir) {
    return { success: false, error: 'workingDir not bound', items: [], truncated: false };
  }
  type RawScan = Awaited<ReturnType<typeof window.electronAPI.maker.scanAtResources>>;
  const res: RawScan = deviceId
    ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'maker:scan-at-resources', [
        agentKind,
        { workingDir, cap, query },
      ])) as RawScan)
    : await window.electronAPI.maker.scanAtResources(agentKind, { workingDir, cap, query });
  if (!res.success || !res.items) {
    return {
      success: false,
      error: res.error ?? 'scan failed',
      items: [],
      truncated: !!res.truncated,
    };
  }

  // Split into buckets so we can apply the agent-wins rule, then
  // reassemble in a deterministic order (agents first in the raw list —
  // the UI will re-rank during filtering anyway).
  const agents: AtResourceItem[] = [];
  const files: AtResourceItem[] = [];
  const dirs: AtResourceItem[] = [];
  const agentNames = new Set<string>();

  for (const item of res.items) {
    if (item.type === 'agent') {
      agentNames.add(item.name);
      agents.push({
        type: 'agent', name: item.name, relPath: item.relPath,
        description: item.description,
        _nameLower: item.name.toLowerCase(),
        _relPathLower: item.relPath.toLowerCase(),
      });
    }
  }
  for (const item of res.items) {
    if (item.type === 'file') {
      const bare = item.name.replace(/\.md$/, '');
      if (agentNames.has(bare)) {
        log.warn(
          `File "${item.relPath}" conflicts with agent "${bare}"; agent wins.`,
        );
        continue;
      }
      files.push({
        type: 'file', name: item.name, relPath: item.relPath,
        _nameLower: item.name.toLowerCase(),
        _relPathLower: item.relPath.toLowerCase(),
      });
    } else if (item.type === 'dir') {
      dirs.push({
        type: 'dir', name: item.name, relPath: item.relPath,
        _nameLower: item.name.toLowerCase(),
        _relPathLower: item.relPath.toLowerCase(),
      });
    }
  }

  return {
    success: true,
    items: [...agents, ...dirs, ...files],
    truncated: !!res.truncated,
  };
}

/**
 * Lightweight fuzzy scorer. Returns a positive number (higher = better) if
 * the query characters appear in order inside `name` or `relPath`. Returns
 * -1 for no match.
 *
 * Scoring priorities (per F2 spec "filename优先于路径"):
 *   +1000 — name starts with query (exact prefix)
 *   +500  — name contains query as a contiguous substring
 *   +100  — name matches fuzzy in-order
 *   +50   — path (not name) matches fuzzy in-order
 *
 * Length tiebreak: shorter names score slightly higher (closer to prefix).
 */
function scoreItem(item: AtResourceItem, q: string): number {
  if (!q) return 1; // empty query = everything matches with baseline score
  const name = item._nameLower ?? item.name.toLowerCase();
  const rel = item._relPathLower ?? item.relPath.toLowerCase();

  if (name.startsWith(q)) return 1000 - name.length;
  if (name.includes(q)) return 500 - name.length;

  // Fuzzy: all chars of q appear in order in name?
  if (fuzzyInOrder(name, q)) return 100 - name.length;
  if (fuzzyInOrder(rel, q)) return 50 - rel.length / 10;
  return -1;
}

function fuzzyInOrder(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Filter + rank against a query. Agents and files are ranked together in
 * the same pool (F5: "agent 项与文件项完全平铺"), no artificial boost for
 * one type over the other — the raw scorer already privileges name matches
 * and agents tend to have short memorable names so they naturally rise.
 */
export function filterAtResources(
  items: AtResourceItem[],
  query: string,
  limit = 25,
): AtResourceItem[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ item: AtResourceItem; score: number }> = [];
  for (const item of items) {
    const s = scoreItem(item, q);
    if (s >= 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  // Cap rendered items — the panel is max ~9 visible rows; rendering
  // beyond `limit` wastes DOM nodes and causes jank on large projects.
  if (scored.length > limit) scored.length = limit;
  return scored.map((s) => s.item);
}
