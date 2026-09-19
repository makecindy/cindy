/** Task labels belong to the owner database of the device hosting the task. */
export const TASK_TAG_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
  'pink',
  'coral',
  'teal',
  'indigo',
  'white',
] as const;
export type TaskTagColor = (typeof TASK_TAG_COLORS)[number] | 'none';
export interface TaskTag {
  id: string;
  name: string;
  color: TaskTagColor;
  favoriteOrder: number | null;
  /** Missing on older hosts; legacy favorite ordering remains the fallback. */
  sortOrder?: number | null;
  revision: number;
}
/** Default names are localized for display until the user renames the tag. */
export const TASK_TAG_PRESETS = [
  {
    id: 'preset:important',
    name: 'Important',
    color: 'coral',
    key: 'presetImportant',
  },
  {
    id: 'preset:follow-up',
    name: 'Follow up',
    color: 'pink',
    key: 'presetFollowUp',
  },
  { id: 'preset:work', name: 'Work', color: 'indigo', key: 'presetWork' },
  { id: 'preset:life', name: 'Life', color: 'teal', key: 'presetLife' },
  { id: 'preset:ideas', name: 'Ideas', color: 'white', key: 'presetIdeas' },
  {
    id: 'preset:reference',
    name: 'Reference',
    color: 'gray',
    key: 'presetReference',
  },
] as const;

export function taskTagNameKey(tag: TaskTag): string | null {
  const preset = TASK_TAG_PRESETS.find((item) => item.id === tag.id && item.name === tag.name);
  if (preset) return `taskTags.${preset.key}`;
  const originalColor = TASK_TAG_COLORS.find((color) => tag.id === `default:${color}`);
  return originalColor && tag.name === originalColor[0].toUpperCase() + originalColor.slice(1)
    ? `taskTags.${originalColor}`
    : null;
}

export type TaskTagRequest =
  | { action: 'list' }
  | { action: 'reorder'; tagIds: string[]; expectedOrder: string[] }
  | {
      action: 'create';
      name: string;
      color: TaskTagColor;
      favorite?: boolean;
      /** Explicit preset creation; name and color must match its canonical definition. */
      presetId?: (typeof TASK_TAG_PRESETS)[number]['id'];
    }
  | {
      action: 'update';
      tagId: string;
      revision: number;
      name?: string;
      color?: TaskTagColor;
      favorite?: boolean;
    }
  | { action: 'previewDelete'; tagId: string }
  | { action: 'delete'; tagId: string; revision: number; expectedCount: number }
  | { action: 'attach' | 'detach'; sessionIds: string[]; tagIds: string[] }
  | { action: 'get'; sessionIds: string[] }
  | { action: 'find'; tagId: string; offset?: number; limit?: number };
export interface TaskTagResult {
  supportedColors?: TaskTagColor[];
  tags: TaskTag[];
  sessions: Array<{ sessionId: string; tags: TaskTag[] }>;
  deletion?: { tagId: string; revision: number; count: number };
  hasMore?: boolean;
}
/** Wire/cache guard: old hosts omit the field, malformed data never becomes a color. */
export function normalizeTaskTags(value: unknown, limit = 32): TaskTag[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .filter(
      (tag): tag is TaskTag =>
        !!tag &&
        typeof tag === 'object' &&
        typeof tag.id === 'string' &&
        tag.id.length <= 128 &&
        typeof tag.name === 'string' &&
        tag.name.length <= 80 &&
        (tag.color === 'none' || TASK_TAG_COLORS.includes(tag.color)) &&
        typeof tag.revision === 'number' &&
        (tag.sortOrder == null || (Number.isInteger(tag.sortOrder) && tag.sortOrder >= 0)) &&
        (tag.favoriteOrder === null || Number.isInteger(tag.favoriteOrder)),
    )
    .sort(compareTaskTags);
}

/** Same deterministic color-ball order for SQL snapshots, pushes and caches. */
export function compareTaskTags(a: TaskTag, b: TaskTag): number {
  const rank = (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
  if (rank) return rank;
  const order =
    (a.favoriteOrder ?? Number.MAX_SAFE_INTEGER) - (b.favoriteOrder ?? Number.MAX_SAFE_INTEGER);
  const compareText = (left: string, right: string) => {
    const a = Array.from(left),
      b = Array.from(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
      if (difference) return difference;
    }
    return a.length - b.length;
  };
  // Match SQLite BINARY (UTF-8/codepoint), including supplementary-plane names.
  return order || compareText(a.name, b.name) || compareText(a.id, b.id);
}
export function reconcileTaskTags(
  current: readonly TaskTag[] | undefined,
  catalog: readonly TaskTag[],
): TaskTag[] {
  const ids = new Set((current ?? []).map((tag) => tag.id));
  return catalog.filter((tag) => ids.has(tag.id)).sort(compareTaskTags);
}

/** Association/order changes advance the version without changing the edit baseline. */
export function taskTagEditRevision(editing: TaskTag, catalog: readonly TaskTag[]): number {
  const latest = catalog.find((tag) => tag.id === editing.id);
  return latest && latest.name === editing.name && latest.color === editing.color
    ? Math.max(editing.revision, latest.revision)
    : editing.revision;
}

/** Device-link errors carry code separately from Error.message. */
export function taskTagErrorKey(error: unknown, action: TaskTagRequest['action']): string {
  const value = error as {
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown };
  } | null;
  const code =
    value && typeof value === 'object' ? String(value.code ?? value.error?.code ?? '') : '';
  const message =
    value && typeof value === 'object'
      ? String(value.message ?? value.error?.message ?? error)
      : String(error);
  if (
    ['CHANNEL_NOT_ALLOWED', 'UNKNOWN_CHANNEL', 'UNSUPPORTED_CHANNEL', 'METHOD_NOT_FOUND'].includes(
      code,
    ) ||
    /CHANNEL_NOT_ALLOWED|No handler|not supported|not allowed remotely|unknown channel/i.test(
      message,
    )
  )
    return 'unavailable';
  if (
    ['DEVICE_OFFLINE', 'NOT_CONNECTED', 'LINK_NOT_OPEN'].includes(code) ||
    /OFFLINE|disconnected/i.test(message)
  )
    return 'offline';
  if (code === 'CONFLICT' || /\[CONFLICT\]/.test(message)) return 'conflict';
  if (code === 'FAVORITES_FULL' || /\[FAVORITES_FULL\]/.test(message)) return 'favoritesFull';
  if (code === 'ALREADY_EXISTS' || /\[ALREADY_EXISTS\]/.test(message)) return 'alreadyExists';
  return ['get', 'list', 'find', 'previewDelete'].includes(action) ? 'loadFailed' : 'failed';
}
