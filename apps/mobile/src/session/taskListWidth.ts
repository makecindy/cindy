/** Shared visible width for the floating task list and the side column. */
export const TASK_LIST_WIDTH = { min: 300, max: 420, default: 400 } as const;

export function taskListResizeBounds(available: number) {
  const max = Math.max(0, Math.min(TASK_LIST_WIDTH.max, available));
  return { min: Math.min(TASK_LIST_WIDTH.min, max), max };
}

export function taskListWidth(preferred: number | null | undefined, bounds: { min: number; max: number }) {
  const requested = typeof preferred === 'number' && Number.isFinite(preferred) ? preferred : TASK_LIST_WIDTH.default;
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, requested)));
}
