import { i18n } from '@/i18n';
import {
  buildFileBrowserGridItems as buildFileBrowserGridItemsShared,
  buildWorkdirPathLevels as buildWorkdirPathLevelsShared,
  type FileBrowserRemoteOpEntry,
  type FileBrowserSortMode,
} from '@cindy/maker-shared/file-browser-grid';

export {
  fileThumbKind,
  filterFileNameMatches,
  joinRelPath,
  normalizeRemoteOpDirEntries,
  parentRelPath,
  type FileBrowserGridItem,
  type FileBrowserNameMatch,
  type FileBrowserPathLevel,
  type FileBrowserRemoteOpEntry,
  type FileBrowserSortMode,
  type FileBrowserViewMode,
} from '@cindy/maker-shared/file-browser-grid';

export function formatFileBrowserDate(mtimeMs: number, nowMs: number): string {
  if (!mtimeMs) return '';
  const date = new Date(mtimeMs);
  const now = new Date(nowMs);
  const dayStart = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  const time = new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  if (diffDays === 0) return i18n.t('files.presentation.grid.today', { time });
  if (diffDays === 1) return i18n.t('files.presentation.grid.yesterday', { time });
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }),
  }).format(date);
}

export function buildFileBrowserGridItems(
  entries: readonly FileBrowserRemoteOpEntry[],
  sort: FileBrowserSortMode,
  nowMs: number,
) {
  return buildFileBrowserGridItemsShared(entries, sort, nowMs).map((item) => ({
    ...item,
    metaLabel: item.kind === 'dir'
      ? formatFileBrowserDate(item.mtimeMs, nowMs)
      : [formatByteSize(item.sizeBytes), formatFileBrowserDate(item.mtimeMs, nowMs)].filter(Boolean).join(' · '),
  }));
}

export function summarizeFileBrowserGrid(items: readonly { kind: 'dir' | 'file' }[]): string {
  const dirs = items.filter((item) => item.kind === 'dir').length;
  const files = items.length - dirs;
  if (items.length === 0) return i18n.t('files.presentation.grid.empty');
  if (dirs > 0 && files > 0) return i18n.t('files.presentation.grid.summaryMixed', { dirs, files });
  return dirs > 0
    ? i18n.t('files.presentation.grid.summaryDirs', { count: dirs })
    : i18n.t('files.presentation.grid.summaryFiles', { count: files });
}

export function buildWorkdirPathLevels(workdirPath: string, relPath: string) {
  const levels = buildWorkdirPathLevelsShared(workdirPath, relPath);
  if (!workdirPath && levels.length > 0) {
    levels[levels.length - 1] = {
      ...levels[levels.length - 1],
      label: i18n.t('files.presentation.grid.workdir'),
    };
  }
  return levels;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
