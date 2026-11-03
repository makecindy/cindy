export interface SmokeElement {
  element_token?: string;
  role?: string;
  label?: string;
}

// `[N] AXRole (label)`, `[N] AXRole "label"` or `[N] AXRole = "value"`.
const MARKDOWN_ROW = /^\s*- \[(\d+)\] (AX\w+)(?:\s+(?:\(([^)]*)\)|"([^"]*)"|= "([^"]*)"))?/;

/**
 * Elements of a Computer Use `get_window_state` observation, addressed the way the
 * model does: Cindy returns only `tree_markdown` once it is non-empty, and a row `[N]`
 * is `<data.snapshot_id>:N`. Drivers or degraded reads that return only `elements`
 * keep working through that list.
 */
export function windowStateElements(data: unknown): SmokeElement[] {
  const state = data as { elements?: unknown; tree_markdown?: unknown; snapshot_id?: unknown } | null | undefined;
  if (typeof state?.tree_markdown === 'string' && typeof state.snapshot_id === 'string') {
    const rows: SmokeElement[] = [];
    for (const line of state.tree_markdown.split('\n')) {
      const match = MARKDOWN_ROW.exec(line);
      if (!match) continue;
      rows.push({
        element_token: `${state.snapshot_id}:${match[1]}`,
        role: match[2],
        label: match[3] ?? match[4] ?? match[5],
      });
    }
    if (rows.length > 0) return rows;
  }
  return Array.isArray(state?.elements) ? (state.elements as SmokeElement[]) : [];
}
