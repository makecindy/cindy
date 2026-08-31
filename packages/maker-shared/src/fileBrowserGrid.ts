/**
 * 手机版远程文件浏览(网格/列表视图)的纯展示模型。
 *
 * 数据源是桌面被控端 `file-browser:remote-op` 聚合通道的 listDir / listAllFiles
 * 返回值(与桌面 workdir-browse 同源的 DirEntry 形状:relPath + type + size + mtimeMs)。
 * 本模块只做归一化、排序、显示文案与缩略图策略等确定性转换,不做任何 IO;
 * 时间相关格式化一律显式传入 nowMs,保证可测试。
 */
import { formatByteSize, isTextFilePreviewCandidate, remoteFilePreviewKind, type RemoteFilePreviewKind } from './filePreview.js';
import { presentationDate, presentationText, type PresentationLocalizer } from './presentationLocalization.js';

/** `file-browser:remote-op` listDir 返回的目录项(桌面 file-browser-core DirEntry 同形)。 */
export interface FileBrowserRemoteOpEntry {
  name: string;
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

/** 网格 / 列表共用的显示项。 */
export interface FileBrowserGridItem {
  key: string;
  name: string;
  relPath: string;
  kind: 'dir' | 'file';
  /** 文件的预览类型(目录为 undefined)。 */
  previewKind?: RemoteFilePreviewKind;
  /** 缩略图策略:folder=文件夹色块;image=远程缩略图;doc=迷你文档页;generic=类型占位。 */
  thumb: 'folder' | 'image' | 'doc' | 'generic';
  /** 次行 meta 文案(目录=修改日期;文件=大小 · 修改日期)。 */
  metaLabel: string;
  sizeBytes: number;
  mtimeMs: number;
}

export type FileBrowserSortMode = 'name' | 'mtime' | 'size';
export type FileBrowserViewMode = 'grid' | 'list';

/** 标题 ⌄ 菜单里的路径层级(限 workdir 内部)。 */
export interface FileBrowserPathLevel {
  label: string;
  relPath: string;
  current: boolean;
}

export interface FileBrowserNameMatch {
  name: string;
  /** 所在目录的 workdir 相对路径('' 表示根)。 */
  dirRelPath: string;
  relPath: string;
}

const IMAGE_THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'heif', 'avif']);

/** 防御性归一化 remote-op listDir 的返回(跨版本被控端可能缺字段)。 */
export function normalizeRemoteOpDirEntries(value: unknown): FileBrowserRemoteOpEntry[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.entries)
      ? value.entries
      : [];
  const out: FileBrowserRemoteOpEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const relPath = typeof item.relPath === 'string' ? item.relPath : null;
    const type = item.type === 'directory' || item.type === 'file' ? item.type : null;
    if (!relPath || !type) continue;
    const fallbackName = relPath.split('/').filter(Boolean).pop() ?? relPath;
    out.push({
      relPath,
      type,
      name: typeof item.name === 'string' && item.name ? item.name : fallbackName,
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
      mtimeMs: typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0,
    });
  }
  return out;
}

/** 目录在前;同类内按排序模式(名称升序 / 修改时间降序)。 */
export function buildFileBrowserGridItems(
  entries: readonly FileBrowserRemoteOpEntry[],
  sort: FileBrowserSortMode,
  nowMs: number,
  localizer?: PresentationLocalizer,
): FileBrowserGridItem[] {
  const items = entries.map((entry): FileBrowserGridItem => {
    const isDir = entry.type === 'directory';
    const previewKind = isDir ? undefined : remoteFilePreviewKind(entry.name);
    return {
      key: `${isDir ? 'dir' : 'file'}:${entry.relPath}`,
      name: entry.name,
      relPath: entry.relPath,
      kind: isDir ? 'dir' : 'file',
      previewKind,
      thumb: isDir ? 'folder' : fileThumbKind(entry.name),
      metaLabel: isDir
        ? formatFileBrowserDate(entry.mtimeMs, nowMs, localizer)
        : `${formatByteSize(entry.size)} · ${formatFileBrowserDate(entry.mtimeMs, nowMs, localizer)}`,
      sizeBytes: entry.size,
      mtimeMs: entry.mtimeMs,
    };
  });
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (sort === 'mtime' && a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    // 大小排序只对文件有意义(目录 size 无语义,维持名称序),文件降序。
    if (sort === 'size' && a.kind === 'file' && a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

/** 文件缩略图策略:图片走远程缩略图;可文本预览的画迷你文档页;其余类型占位。 */
export function fileThumbKind(name: string): 'image' | 'doc' | 'generic' {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (IMAGE_THUMB_EXT.has(ext)) return 'image';
  if (isTextFilePreviewCandidate(name)) return 'doc';
  return 'generic';
}

/** 修改时间的相对化显示:今天/昨天带时分,当年只到月日,跨年带年份。 */
export function formatFileBrowserDate(
  mtimeMs: number,
  nowMs: number,
  localizer?: PresentationLocalizer,
): string {
  if (!mtimeMs) return '';
  const d = new Date(mtimeMs);
  const now = new Date(nowMs);
  const dayStart = (v: Date) => new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diffDays === 0) {
    return presentationText(localizer, 'files.presentation.grid.today', `Today ${hhmm}`, { time: hhmm });
  }
  if (diffDays === 1) {
    return presentationText(localizer, 'files.presentation.grid.yesterday', `Yesterday ${hhmm}`, { time: hhmm });
  }
  if (localizer?.formatDate) return presentationDate(localizer, d);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() === now.getFullYear()
    ? `${mm}-${dd}`
    : `${d.getFullYear()}-${mm}-${dd}`;
}

/** 底部汇总:「X 个文件夹、Y 个文件」;单一类别时只报一类;空目录固定文案。 */
export function summarizeFileBrowserGrid(items: readonly FileBrowserGridItem[]): string {
  const dirs = items.filter((item) => item.kind === 'dir').length;
  const files = items.length - dirs;
  if (items.length === 0) return '文件夹为空';
  if (dirs > 0 && files > 0) return `${dirs} 个文件夹、${files} 个文件`;
  return dirs > 0 ? `${dirs} 个文件夹` : `${files} 个文件`;
}

/** 标题 ⌄ 菜单的路径层级(根 = workdir basename;只覆盖 workdir 内部)。 */
export function buildWorkdirPathLevels(workdirPath: string, relPath: string): FileBrowserPathLevel[] {
  const rootLabel = workdirPath.split(/[\\/]/).filter(Boolean).pop() ?? workdirPath ?? '工作目录';
  const segments = splitRelPath(relPath);
  const levels: FileBrowserPathLevel[] = [{ label: rootLabel, relPath: '', current: segments.length === 0 }];
  let current = '';
  for (let i = 0; i < segments.length; i += 1) {
    current = current ? `${current}/${segments[i]}` : segments[i];
    levels.push({ label: segments[i], relPath: current, current: i === segments.length - 1 });
  }
  // 菜单按「当前 → 根」的就近顺序展示
  return levels.reverse();
}

export function parentRelPath(relPath: string): string | null {
  const segments = splitRelPath(relPath);
  if (segments.length === 0) return null;
  return segments.slice(0, -1).join('/');
}

export function joinRelPath(dirRelPath: string, name: string): string {
  return dirRelPath ? `${dirRelPath}/${name}` : name;
}

/**
 * 文件名搜索(数据源 = listAllFiles 的 workdir 相对路径清单)。
 * 排名:basename 前缀命中 > basename 包含 > 路径包含;同级按路径短者优先。
 */
export function filterFileNameMatches(
  files: readonly string[],
  query: string,
  limit = 50,
): FileBrowserNameMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<{ rank: number; match: FileBrowserNameMatch }> = [];
  for (const relPath of files) {
    const segments = splitRelPath(relPath);
    const name = segments.pop() ?? relPath;
    const lowerName = name.toLowerCase();
    let rank: number;
    if (lowerName.startsWith(q)) rank = 0;
    else if (lowerName.includes(q)) rank = 1;
    else if (relPath.toLowerCase().includes(q)) rank = 2;
    else continue;
    ranked.push({ rank, match: { name, dirRelPath: segments.join('/'), relPath } });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.match.relPath.length !== b.match.relPath.length) return a.match.relPath.length - b.match.relPath.length;
    return a.match.relPath.localeCompare(b.match.relPath);
  });
  return ranked.slice(0, limit).map((item) => item.match);
}

function splitRelPath(relPath: string): string[] {
  return relPath.split('/').filter((part) => part.length > 0 && part !== '.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
