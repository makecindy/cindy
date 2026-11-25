import type { DagCanvasState, DagSize } from './types';
import { cardSize } from './layout';

/** The edit follows the accepted input when its provisional ID becomes a native turn. */
export function inverseSizeEdit(id: () => string, before: DagSize | undefined, expected: DagSize): CanvasUndo {
  return state => {
    const key = id(), current = cardSize(state.sizes, key);
    if (current.width !== expected.width || current.height !== expected.height) conflict();
    const sizes = { ...state.sizes };
    if (before) sizes[key] = before; else delete sizes[key];
    return { ...state, sizes };
  };
}

export type CanvasUndo = (current: DagCanvasState) => DagCanvasState;
const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const conflict = () => {
  throw new Error('画布内容已经变化，未覆盖更新的内容。');
};

/** Capture only edited keys, never a whole snapshot that could resurrect a submitted draft. */
export function inverseCanvasEdit(
  before: DagCanvasState,
  after: DagCanvasState,
  resolveDraftId: (id: string) => string = id => id,
): CanvasUndo | undefined {
  const patches: CanvasUndo[] = [];
  for (const field of ['positions', 'labels', 'summaries', 'selectedVersions'] as const) {
    if (before[field] === after[field]) continue;
    const old: Record<string, unknown> = before[field] ?? {},
      next: Record<string, unknown> = after[field] ?? {};
    const changed = [...new Set([...Object.keys(old), ...Object.keys(next)])]
      .filter((id) => !equal(old[id], next[id]))
      .map((id) => [id, old[id], next[id]] as const);
    if (changed.length)
      patches.push((state) => {
        const values: Record<string, unknown> = { ...state[field] };
        for (const [original, previous, expected] of changed) {
          const id = field === 'summaries' ? resolveDraftId(original) : original;
          if (!equal(values[id], expected)) conflict();
          if (previous === undefined) delete values[id];
          else values[id] = previous;
        }
        return { ...state, [field]: values };
      });
  }
  for (const field of ['revisions', 'references'] as const) {
    if (before[field] === after[field]) continue;
    const old = new Map(before[field].map((v, i) => [v.id, { v, i }] as const));
    const next = new Map(after[field].map((v) => [v.id, v] as const));
    const changed = [...new Set([...old.keys(), ...next.keys()])]
      .filter((id) => !equal(old.get(id)?.v, next.get(id)))
      .map((id) => ({ id, old: old.get(id), next: next.get(id) }));
    if (changed.length)
      patches.push((state) => {
        const values: (
          DagCanvasState['revisions'][number] | DagCanvasState['references'][number]
        )[] = [...state[field]];
        for (const c of changed) {
          const i = values.findIndex((v) => v.id === c.id);
          if (!equal(values[i], c.next)) conflict();
          if (i >= 0) values.splice(i, 1);
          if (c.old) values.splice(Math.min(c.old.i, values.length), 0, c.old.v);
        }
        return { ...state, [field]: values };
      });
  }
  // Only a placement change can enter history. Never restore a retired placeholder.
  if (before.pendingBranches !== after.pendingBranches) {
    const old = new Map(before.pendingBranches?.map((p) => [p.id, p]));
    const moves = (after.pendingBranches ?? []).flatMap((p) => {
      const last = old.get(p.id);
      return last && !equal(last.point, p.point)
        ? [{ id: p.id, from: last.point, to: p.point }]
        : [];
    });
    if (moves.length)
      patches.push((state) => {
        const pendingBranches = [...(state.pendingBranches ?? [])];
        for (const m of moves) {
          const i = pendingBranches.findIndex((p) => p.id === m.id);
          if (i < 0 || !equal(pendingBranches[i].point, m.to)) conflict();
          pendingBranches[i] = { ...pendingBranches[i], point: m.from };
        }
        return { ...state, pendingBranches };
      });
  }
  return patches.length
    ? (state) => patches.reduce((next, patch) => patch(next), state)
    : undefined;
}
