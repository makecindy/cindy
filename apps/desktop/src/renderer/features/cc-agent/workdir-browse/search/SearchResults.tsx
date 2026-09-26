import { FileTypeIcon } from '@/components/ui/file-type-icon';
/**
 * SearchResults — 文件搜索结果树
 *
 * Specs:
 *   FileGroup container: layout vertical (无 gap)
 *
 *   FileHeader:  h:26  padding [0, 4, 0, 8]  cornerRadius:6  gap:6
 *     ├ chevron-down/right 12×12 fill #737373
 *     ├ file-code 14×14 fill #737373
 *     ├ fhText (clip, fill_container, gap:6):
 *     │   filename Inter 13 / 500 / #262626 (Light) / #f5f5f5 (Dark)
 *     │   parentDir Inter 11 / normal / #a3a3a3 (Silver)
 *     └ badge cornerRadius:9999 fill #e5e5e5/#363634 padding [1,6]
 *         number Inter 11 / 600 / #262626/#f5f5f5
 *
 *   MatchRow:    h:22  padding [0, 4, 0, 30]  cornerRadius:4
 *     selected fill #e5e5e5 / #363634
 *     preview (horizontal, clip, fill_container):
 *       text fragments Inter 12 / normal / #737373
 *       match  cornerRadius:2 fill #fde68a / #854d0e padding [0,2]
 *              inner text Inter 12 / normal / #262626 / #fde68a
 *
 * 字节偏移 → 字符偏移转换:rg 给的是 UTF-8 byte offset, JS string 是 UTF-16,
 * 用 TextEncoder 滚一遍换算,处理 CJK / emoji。
 *
 * 虚拟化:
 *   把 file group 和 match rows 平铺成一个统一的 row 列表(rowKind = 'header'
 *   | 'match'),用 @tanstack/react-virtual 做单层虚拟化。两种 row 高度固定
 *   (header 26px, match 22px),用 estimateSize 按 kind 区分即可,不需要测量。
 *   折叠的 file group 只贡献一行 header,展开的贡献 1 + matches.length 行。
 *
 *   单层虚拟化比"嵌套"(每个 file 内部再虚拟化)简单得多,且 row 数据是扁平
 *   数组,scroll 时复用更稳。代价是切换折叠状态会让所有 row 索引位移,但 react-
 *   virtual 内部用 measure cache 处理得很快,实测几千 row 切换也无感。
 *
 *   useMemo 把 results + collapsed → flat rows 的映射做出来; deps 是 results
 *   引用 + collapsed Set 引用。collapsed toggle 时 setState 给新 Set, 触发重算。
 */

import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { FileResult, MatchLine } from './hooks/useProjectSearch';

export interface SearchResultsProps {
  results: FileResult[];
  /** 用户点命中行 → 打开文件 + 跳到对应行(由上层处理 URL setSearchParams)。 */
  onOpenMatch: (relPath: string, lineNumber: number) => void;
}

/** 平铺后的虚拟列表 row。header / match 两种,都带 fileIndex 方便定位回源数据。 */
type FlatRow =
  | { kind: 'header'; fileIndex: number; relPath: string; matchCount: number }
  | { kind: 'match'; fileIndex: number; matchIndex: number; relPath: string; match: MatchLine };

const HEADER_HEIGHT = 26;
const MATCH_HEIGHT = 22;
// react-virtual 提前渲染上下视口外多少 row。设 8 = 大约多渲一屏的 1/3 左右,
// 滚动到视口边缘时下一行已经在 DOM 里, 不会有"空白闪一下"的感觉。
const OVERSCAN = 8;

export function SearchResults({ results, onOpenMatch }: SearchResultsProps) {
  // 折叠态:per-relPath。默认全展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (relPath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  // 把 results × collapsed 映射成一个扁平 row 数组。
  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    results.forEach((file, fi) => {
      out.push({
        kind: 'header',
        fileIndex: fi,
        relPath: file.relPath,
        matchCount: file.matches.length,
      });
      if (!collapsed.has(file.relPath)) {
        file.matches.forEach((m, mi) => {
          out.push({ kind: 'match', fileIndex: fi, matchIndex: mi, relPath: file.relPath, match: m });
        });
      }
    });
    return out;
  }, [results, collapsed]);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index].kind === 'header' ? HEADER_HEIGHT : MATCH_HEIGHT),
    overscan: OVERSCAN,
    // 用 row 内容的"稳定 key"作为虚拟化 key — 同 relPath/lineNumber 的 row 在
    // collapsed toggle 后位置变了, react-virtual 仍然能复用其 measure 缓存。
    getItemKey: (index) => {
      const r = rows[index];
      return r.kind === 'header' ? `h:${r.relPath}` : `m:${r.relPath}:${r.matchIndex}`;
    },
  });

  return (
    // parentRef 上接管滚动 —— 父组件 SearchPanel 给出 overflow-y-auto 的容器,
    // 但虚拟化要求"滚动容器是虚拟化器知道的那个 element"。所以我们这里再套一层
    // h-full 的滚动容器, 由它真正承担滚动。SearchPanel 那一层的 overflow-y-auto
    // 在虚拟化模式下退化成 noop(子项总高度 < 父容器时才能滚, 这里子项是固定
    // 高度的 totalSize, 永远撑满)。
    <div ref={parentRef} className="h-full w-full overflow-y-auto overflow-x-hidden">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {row.kind === 'header' ? (
                <FileHeader
                  relPath={row.relPath}
                  matchCount={row.matchCount}
                  collapsed={collapsed.has(row.relPath)}
                  onToggle={() => toggle(row.relPath)}
                />
              ) : (
                <MatchRow
                  match={row.match}
                  onClick={() => onOpenMatch(row.relPath, row.match.lineNumber)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface FileHeaderProps {
  relPath: string;
  matchCount: number;
  collapsed: boolean;
  onToggle: () => void;
}

function FileHeader({ relPath, matchCount, collapsed, onToggle }: FileHeaderProps) {
  const { fileName, parentDir } = useMemo(() => splitPath(relPath), [relPath]);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex h-[26px] w-full items-center gap-1.5 overflow-hidden rounded-md',
        'pr-1 pl-2 text-left transition-colors hover:bg-sidebar-item-hover',
      )}
    >
      <Chevron size={12} strokeWidth={2} className="shrink-0 text-sidebar-action-icon" />
      <FileTypeIcon name={fileName} size={14} className="shrink-0 text-sidebar-action-icon" />
      {/* fileName 优先显示完整, 极长时也允许 truncate. parentDir 在剩余空间里挤. */}
      <span className="min-w-0 truncate text-13 font-medium text-foreground">{fileName}</span>
      {parentDir && (
        <span className="min-w-0 flex-1 truncate text-11 text-[var(--cmd-palette-item-meta)]">
          {parentDir}
        </span>
      )}
      <span
        className={cn(
          'ml-auto shrink-0 rounded-full bg-sidebar-item-active',
          'px-1.5 py-px text-11 font-semibold text-sidebar-item-active-foreground',
        )}
      >
        {matchCount}
      </span>
    </button>
  );
}

interface MatchRowProps {
  match: MatchLine;
  onClick: () => void;
}

function MatchRow({ match, onClick }: MatchRowProps) {
  const fragments = useMemo(
    () => splitLineByMatches(match.lineText, match.submatches),
    [match.lineText, match.submatches],
  );
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Line ${match.lineNumber}`}
      className={cn(
        'flex h-[22px] w-full items-center rounded-[4px]',
        'pr-1 pl-[30px] text-left transition-colors hover:bg-sidebar-item-hover',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-12 leading-none">
        {fragments.map((f) =>
          f.type === 'text' ? (
            <span key={f.key} className="font-normal text-sidebar-muted">
              {f.text}
            </span>
          ) : (
            <span
              key={f.key}
              className="rounded-[2px] bg-search-match-bg px-0.5 font-normal text-search-match-fg"
            >
              {f.text}
            </span>
          ),
        )}
      </div>
    </button>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function splitPath(relPath: string): { fileName: string; parentDir: string } {
  const idx = relPath.lastIndexOf('/');
  if (idx < 0) return { fileName: relPath, parentDir: '' };
  return { fileName: relPath.slice(idx + 1), parentDir: relPath.slice(0, idx) };
}

interface Fragment {
  type: 'text' | 'match';
  text: string;
  key: string;
}

/**
 * 把一行原文按 rg 给的 byte-offset 列表切成 [text, match, text, match, ...]。
 * submatches 已按 start 升序(rg 保证), 这里再做一次防御性排序。
 * 行预览前缀的空白被 trimStart 砍掉, 给视觉留出更多空间显示真正有意义的部分。
 */
function splitLineByMatches(
  line: string,
  submatches: Array<{ start: number; end: number }>,
): Fragment[] {
  if (submatches.length === 0) {
    return [{ type: 'text', text: line.trimStart(), key: `text:0:${line.length}` }];
  }
  const sorted = [...submatches].sort((a, b) => a.start - b.start);
  const offsets = computeByteToCharIndex(line, sorted.flatMap((s) => [s.start, s.end]));
  const out: Fragment[] = [];
  let cursor = 0;
  const leadingTrim = line.length - line.trimStart().length;

  sorted.forEach((_, i) => {
    const startCharIdx = Math.max(offsets[i * 2], cursor);
    const endCharIdx = Math.max(offsets[i * 2 + 1], startCharIdx);
    if (startCharIdx > cursor) {
      const segStart = Math.max(cursor, leadingTrim);
      const text = line.slice(segStart, startCharIdx);
      if (text) out.push({ type: 'text', text, key: `text:${segStart}:${startCharIdx}` });
    }
    const matchSegStart = Math.max(startCharIdx, leadingTrim);
    const matchText = line.slice(matchSegStart, endCharIdx);
    if (matchText) out.push({ type: 'match', text: matchText, key: `match:${matchSegStart}:${endCharIdx}` });
    cursor = endCharIdx;
  });
  if (cursor < line.length) {
    out.push({ type: 'text', text: line.slice(cursor), key: `text:${cursor}:${line.length}` });
  }
  return out;
}

/**
 * 把一组 UTF-8 byte offsets (升序) 换算成对应的 JavaScript string index。
 * 单次扫描, O(n + bytes)。
 */
function computeByteToCharIndex(text: string, byteOffsets: number[]): number[] {
  if (byteOffsets.length === 0) return [];
  const out: number[] = new Array(byteOffsets.length);
  const encoder = new TextEncoder();
  let charIdx = 0;
  let byteIdx = 0;
  let pendingIdx = 0;
  while (pendingIdx < byteOffsets.length) {
    const target = byteOffsets[pendingIdx];
    while (byteIdx < target && charIdx < text.length) {
      const code = text.codePointAt(charIdx);
      const charLen = code !== undefined && code > 0xffff ? 2 : 1;
      const slice = text.slice(charIdx, charIdx + charLen);
      byteIdx += encoder.encode(slice).length;
      charIdx += charLen;
    }
    out[pendingIdx] = charIdx;
    pendingIdx += 1;
  }
  return out;
}
