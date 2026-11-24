import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Search, Tag, Undo2, X } from 'lucide-react';
import type { DagNode } from './types';

import { graphArchive, type GraphArchiveInput } from './graphArchive';

import { previewDagOperation, type DagOperation } from './dagOperationPreview';

interface Props extends GraphArchiveInput {
  historyReady?: boolean;
  archiveNodes?: DagNode[];
  selectedId: string | null;
  undoLabel?: string;
  onUndo?: () => void;
  onDelete?: (id: string) => void;
  onLabel: (id: string, label: string) => void;
  onFocus: (id: string) => void;
  onVisible: (ids: ReadonlySet<string> | null) => void;
}

export function collectBranch(
  nodes: DagNode[],
  id: string,
  direction: 'path' | 'subtree',
): DagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = byId.get(id);
  if (!start) return [];
  const result: DagNode[] = [];
  const seen = new Set<string>();
  if (direction === 'path') {
    let current: DagNode | undefined = start;
    while (current && !seen.has(current.id)) {
      result.push(current);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return result.reverse();
  }
  const children = new Map<string, DagNode[]>();
  for (const n of nodes)
    if (n.parentId) {
      const list = children.get(n.parentId) ?? [];
      list.push(n);
      children.set(n.parentId, list);
    }
  const pending = [start];
  while (pending.length) {
    const n = pending.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    result.push(n);
    const list = children.get(n.id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) pending.push(list[i]);
  }
  return result;
}
export function findGraphMatches(
  nodes: DagNode[],
  labels: Record<string, string>,
  query: string,
  tag: string,
  status: DagNode['runState'] = undefined,
) {
  const q = query.trim().toLocaleLowerCase();
  return nodes.filter(
    (n) =>
      (!tag || labels[n.id] === tag) &&
      (!status || n.runState === status) &&
      (!q ||
        [n.question, n.answer, n.toolText ?? '', labels[n.id] ?? ''].some((text) =>
          text.toLocaleLowerCase().includes(q),
        )),
  );
}
export function exportGraphMarkdown(
  nodes: DagNode[],
  labels: Record<string, string>,
  selectedVersions: GraphArchiveInput['selectedVersions'] = {},
) {
  return (
    nodes
      .map(
        (n, i) =>
          `## ${i + 1}. ${n.question.trim().replace(/\s+/g, ' ') || '未命名轮次'}\n\n${labels[n.id] ? `标签：${labels[n.id]}\n\n` : ''}**问**\n\n${n.question}\n\n**${selectedVersions[n.id] && selectedVersions[n.id] !== 'origin' ? '答（手动修订）' : '答'}**\n\n${n.answer}`,
      )
      .join('\n\n---\n\n') + '\n'
  );
}
function download(text: string, name: string, mime = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const icon =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 disabled:opacity-40';
export function DagGraphTools(props: Props) {
  const { nodes, labels, selectedId, onFocus, onVisible, onLabel } = props;
  const [mode, setMode] = useState<'search' | 'edit' | null>(null);
  const [operation, setOperation] = useState<DagOperation | null>(null);
  const archiveNodes = props.archiveNodes ?? nodes;
  const preview =
    operation && mode === 'edit'
      ? previewDagOperation({
          operation,
          selectedId,
          nodes: props.originalNodes ?? archiveNodes,
          historyReady: props.historyReady === true,
          canvasState: props.canvasState,
        })
      : null;
  const [query, setQuery] = useState(''),
    [tag, setTag] = useState(''),
    [draft, setDraft] = useState('');
  const [status, setStatus] = useState<DagNode['runState']>();
  const [cursor, setCursor] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const tags = useMemo(
    () => Array.from(new Set(nodes.map((n) => labels[n.id]).filter(Boolean))).sort(),
    [nodes, labels],
  );
  const matches = useMemo(
    () => findGraphMatches(nodes, labels, query, tag, status),
    [nodes, labels, query, tag, status],
  );
  const visibility = useMemo(() => {
    if (!tag && !status) return null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ids = new Set<string>();
    for (const n of nodes)
      if ((!tag || labels[n.id] === tag) && (!status || n.runState === status)) {
        let next: DagNode | undefined = n;
        while (next && !ids.has(next.id)) {
          ids.add(next.id);
          next = next.parentId ? byId.get(next.parentId) : undefined;
        }
      }
    return ids;
  }, [nodes, labels, tag, status]);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    callback.current(visibility);
  }, [visibility]);
  useEffect(() => {
    if (mode) input.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (!mode) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setMode(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [mode]);
  function step(d: number) {
    if (!matches.length) return;
    const index = matches.findIndex((n) => n.id === cursor);
    const n =
      matches[
        index < 0 ? (d > 0 ? 0 : matches.length - 1) : (index + d + matches.length) % matches.length
      ];
    setCursor(n.id);
    onFocus(n.id);
  }
  return (
    <div
      ref={box}
      className="relative flex items-center rounded-md bg-background shadow-sm"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setMode(null);
          e.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        aria-label="查找轮次"
        title="查找轮次"
        aria-expanded={mode === 'search'}
        className={icon}
        onClick={() => setMode(mode === 'search' ? null : 'search')}
      >
        <Search size={16} />
      </button>
      <button
        type="button"
        aria-label="标签与导出"
        title="标签与导出"
        aria-expanded={mode === 'edit'}
        className={icon}
        onClick={() => {
          setOperation(null);
          setDraft(selectedId ? (labels[selectedId] ?? '') : '');
          setMode(mode === 'edit' ? null : 'edit');
        }}
      >
        <Tag size={16} />
      </button>
      <button type="button" className={icon} aria-label={`撤销：${props.undoLabel ?? '上一步操作'}`}
        title={`撤销${props.undoLabel ? `：${props.undoLabel}` : ''}（Ctrl/Cmd+Z）`}
        disabled={!props.onUndo} onClick={props.onUndo}><Undo2 size={16} /></button>
      {status && (
        <button
          type="button"
          className="flex items-center gap-1 px-1 text-xs"
          aria-label="清除状态筛选"
          onClick={() => setStatus(undefined)}
        >
          {status === 'running' ? '运行中' : '出错'} <X size={12} />
        </button>
      )}
      {tag && (
        <button
          type="button"
          title="清除标签筛选"
          aria-label="清除标签筛选"
          className="flex max-w-28 items-center gap-1 truncate px-1 text-xs"
          onClick={() => setTag('')}
        >
          {tag}
          <X size={12} />
        </button>
      )}
      {mode && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[80vw] rounded-lg border border-border bg-background p-2 shadow-md">
          {mode === 'search' ? (
            <>
              <div className="flex items-center">
                <input
                  ref={input}
                  type="search"
                  aria-label="搜索问答或标签"
                  placeholder="搜索问答或标签"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      step(e.shiftKey ? -1 : 1);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent px-1 text-sm"
                />
                <button
                  type="button"
                  className={icon}
                  aria-label="上一个匹配"
                  disabled={!matches.length}
                  onClick={() => step(-1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className={icon}
                  aria-label="下一个匹配"
                  disabled={!matches.length}
                  onClick={() => step(1)}
                >
                  <ArrowDown size={14} />
                </button>
              </div>
              <div className="px-1 text-xs text-muted-foreground" role="status">
                {matches.length
                  ? `${cursor ? matches.findIndex((n) => n.id === cursor) + 1 + ' / ' : ''}${matches.length} 个匹配`
                  : '没有匹配的轮次'}
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs">
                运行状态
                <select
                  value={status ?? ''}
                  className="min-w-0 flex-1 bg-background"
                  onChange={(e) => {
                    const v = e.target.value;
                    setStatus(v === 'running' || v === 'failed' ? v : undefined);
                    setCursor(null);
                  }}
                >
                  <option value="">不限状态</option>
                  <option value="running">运行中</option>
                  <option value="failed">出错</option>
                </select>
              </label>
              {tags.length > 0 && (
                <label className="mt-2 flex items-center gap-2 text-xs">
                  筛选标签
                  <select
                    value={tag}
                    className="min-w-0 flex-1 bg-background"
                    onChange={(e) => {
                      setTag(e.target.value);
                      setCursor(null);
                    }}
                  >
                    <option value="">全部</option>
                    {tags.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ) : selectedId && nodes.some((n) => n.id === selectedId) ? (
            <>
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  onLabel(selectedId, draft.trim());
                  setMode(null);
                }}
              >
                <input
                  ref={input}
                  className="min-w-0 flex-1 bg-transparent px-1 text-sm"
                  aria-label="节点标签"
                  placeholder="节点标签"
                  value={draft}
                  maxLength={64}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button className="rounded px-2 py-1 text-xs hover:bg-muted" type="submit">
                  保存
                </button>
              </form>
              {(['path', 'subtree'] as const).map((direction) => (
                <button
                  type="button"
                  key={direction}
                  disabled={!props.historyReady}
                  className="mt-1 flex w-full items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted"
                  onClick={() => {
                    download(
                      exportGraphMarkdown(
                        collectBranch(archiveNodes, selectedId, direction),
                        labels,
                        props.selectedVersions,
                      ),
                      direction === 'path' ? '会话路径.md' : '会话子树.md',
                    );
                    setMode(null);
                  }}
                >
                  <Download size={14} />
                  {direction === 'path' ? '导出到此轮的路径' : '导出此轮及下游'}
                </button>
              ))}
            </>
          ) : (
            <p className="p-1 text-sm text-muted-foreground">先选择一张卡片。</p>
          )}
          {mode === 'edit' && !props.historyReady && (
            <p className="p-1 text-xs text-muted-foreground">历史未完整载入，暂不能导出。</p>
          )}
          {mode === 'edit' && selectedId && (
            <details className="mt-2 text-xs">
              <summary>{props.onDelete ? '复制或删除范围' : '查看复制或删除范围（只读）'}</summary>
              <select
                aria-label="预览操作"
                value={operation ?? ''}
                onChange={(e) => setOperation((e.target.value || null) as DagOperation | null)}
                className="mt-1 w-full bg-background"
              >
                <option value="">选择要预览的范围</option>
                <option value="copy-path">复制祖先路径</option>
                <option value="copy-subtree">复制后代子树</option>
                <option value="delete-subtree">删除后代子树</option>
              </select>
              {preview && (
                <p role="status" className="p-1">
                  {preview.status === 'unavailable'
                    ? '无法核对完整历史，不估算范围。'
                    : `涉及 ${preview.nodeIds.length} 轮、${preview.projectedSessionCount} 个会话；范围外引用 ${preview.crossingReferences} 条。${operation === 'delete-subtree' ? (props.onDelete ? '最终范围以原生历史预览为准。' : '当前宿主只能删除整项任务，此处不执行删除。') : '当前宿主分叉会保留父会话，此处不创建独立副本。'}`}
                </p>
              )}
              {operation === 'delete-subtree' && props.onDelete && preview?.status === 'preview-only' && (
                <button type="button" className="mt-1 rounded px-2 py-1 text-xs hover:bg-muted" onClick={() => props.onDelete!(selectedId)}>查看原生删除范围</button>
              )}
            </details>
          )}
          {mode === 'edit' &&
            archiveNodes.length > 0 &&
            (['html', 'jsonl'] as const).map((format) => (
              <button
                type="button"
                key={format}
                disabled={!props.historyReady}
                className="mt-1 flex w-full items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted"
                onClick={() => {
                  download(
                    graphArchive({ ...props, nodes: archiveNodes }, format),
                    `会话图.${format}`,
                    format === 'html' ? 'text/html' : 'application/x-ndjson',
                  );
                  setMode(null);
                }}
              >
                <Download size={14} />
                导出整图（{format.toUpperCase()}）
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
