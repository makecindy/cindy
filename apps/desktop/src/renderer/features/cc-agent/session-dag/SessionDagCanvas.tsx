/** A storage key is a privacy boundary: remount the entire editor, including open drafts. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { DagResizeHandle } from './DagResizeHandle';
import { DagViewport } from './DagViewport';
import { DagGraphTools } from './DagGraphTools';

import { copy } from './copy';
import { DagEdgeLayer } from './DagEdgeLayer';
import { ChildDraftCard } from './ChildDraftCard';
import { DagNodeCard } from './DagNodeCard';
import { NativeHistoryDialog } from './dialogs';
import { nextDagId as nextId } from './dagOperationId';
import { DagInlineAside, DagInlineReference, REFERENCE_PANEL_HEIGHT, asidePanelHeight, type AsideInput } from './DagInlineForms';
import { inverseCanvasEdit, inverseSizeEdit, type CanvasUndo } from './canvasUndo';
import {
  autoLayout,
  cardSize,
  DEFAULT_SIZE,
  CARD_GAP_X,
  CARD_GAP_Y,
  contentBounds,
} from './layout';
import { buildAdvanceContext, summarizeAnswer } from './references';
import { listVersions } from './revisions';
import {
  addReference,
  hydrateState,
  reconcileNodes,
  removeReference,
  setNodePosition,
} from './sessionDagState';
import type {
  DagAside,
  DagActionKind,
  DagActionReceipt,
  DagCanvasState,
  DagNode,
  DagPoint,
  DagSize,
  ReferenceSnapshot,
  PendingBranch,
  SessionDagCanvasProps,
} from './types';

const emptyLabels: Record<string, string> = {};
type DragState = { id: number; nodeId: string; startX: number; startY: number; k: number } & (
  | { kind: 'card'; origins: Record<string, DagPoint>; branch: boolean }
  | { kind: 'branch'; anchor: DagPoint; tap: () => void }
);

type ReferenceDraft = {
  operationId: string;
  sourceId: string;
  snapshot: ReferenceSnapshot;
  drop?: { targetId: string };
};

function acceptedTarget(result: DagActionReceipt | false | void, origin: DagNode) {
  if (!result || result.delivery !== 'accepted' || !result.sessionId?.trim()) return null;
  const same = result.sessionId === origin.sessionId;
  if (same !== (result.reused === true) || (same && !result.userMessageId?.trim())) return null;
  return { sessionId: result.sessionId, delivery: result.delivery,
    ...(same && { reused: true as const }), ...(result.userMessageId && { userMessageId: result.userMessageId }) };
}

function projectNode(node: DagNode, question: string, answer: string): DagNode {
  return { ...node, question, answer };
}

export function SessionDagCanvas(props: SessionDagCanvasProps) {
  return <ScopedCanvas key={props.storageKey} {...props} />;
}

function ScopedCanvas({
  nodes,
  fullFamilyNodes,
  historyReady = false,
  storageKey,
  onOpen,
  onPin,
  readOnly,
  onOpenPrepared,
  onOpenChat,
  onRetryFailed,
  onAction,
  historyActions,
  initialState,
  onStateChange,
}: SessionDagCanvasProps) {
  const [state, setState] = useState<DagCanvasState>(() => hydrateState(nodes, initialState));
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string> | null>(null);
  const navigator = useRef<((p: DagPoint) => void) | null>(null);
  const selectedVersions = state.selectedVersions ?? emptyLabels;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sizePreview, setSizePreview] = useState<{ id: string; size: DagSize } | null>(null);
  const projectedDraftIds = useRef(new Map<string, string>());
  const unsentIds = useRef(new Set<string>());
  const [transient, setTransient] = useState<Record<string, DagPoint> | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const [expandedAsides, setExpandedAsides] = useState<ReadonlySet<string>>(new Set());
  const asideInputs = useRef(new Map<string, AsideInput>());
  const openAside = useCallback((id: string) => {
    setSelectedNodeId(id);
    setExpandedAsides(prev => prev.has(id) ? prev : new Set(prev).add(id));
  }, []);
  const [referenceDrafts, setReferenceDrafts] = useState<ReferenceDraft[]>([]);
  const closeReference = (id: string) => setReferenceDrafts(ds => ds.filter(d => d.operationId !== id));
  const [actionError, setActionError] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    node: DagNode;
    kind: 'delete' | 'recall';
    token: string;
    details: string[];
    requiresStop?: boolean;
    error: string;
    busy: boolean;
  } | null>(null);
  const historyBusy = useRef(false);
  const previewSequence = useRef(0);
  type DraftMove = { id: string; before: DagPoint; after: DagPoint };
  type Entry = {label: string; undo: CanvasUndo; metadataId?: string; draftMoves?: DraftMove[]} | {label: string; undoId: string};
  const [undoStack, setUndoStack] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [consumed, setConsumed] = useState<string | null>(null);
  const pendingUndo = useRef(false);
  const lastRemote = historyActions?.latestUndo;
  const entry = undoStack.at(-1) ?? (lastRemote && consumed !== lastRemote.undoId ? lastRemote : undefined);
  const rememberUndo = useCallback((item: Entry) => setUndoStack(s => [...s.slice(-49), item]), []);

  const [childDrafts, setChildDrafts] = useState<
    Array<
      Pick<PendingBranch, 'id' | 'parentId' | 'point' | 'question'> & {
        sessionId?: never;
        delivery?: never;
      }
    >
  >([]);
  const suppressedClick = useRef<string | null>(null);
  const travelled = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dragLine = useRef<SVGLineElement>(null);
  const surface = useRef<HTMLDivElement>(null);

  const latestStateRef = useRef(state);
  useEffect(() => {
    latestStateRef.current = state;
  });

  useEffect(() => {
    setState((prev) => reconcileNodes(prev, nodes));
  }, [nodes]);

  const commit = useCallback(
    (next: DagCanvasState, label?: string, draftMoves?: DraftMove[], metadataId?: string) => {
      if (label) {
        if (readOnly || pendingUndo.current || historyBusy.current) return;
        const undo = inverseCanvasEdit(latestStateRef.current, next, id => projectedDraftIds.current.get(id) ?? id);
        if (undo || draftMoves?.length) rememberUndo({label, undo: undo ?? (s => s), draftMoves, metadataId});
      }
      latestStateRef.current = next;
      setState(next);
      // Unsent cards live only in this editor; do not leak their temporary IDs into the archive.
      if (unsentIds.current.size && (next.sizes || next.summaries)) {
        const sizes = { ...next.sizes }, summaries = { ...next.summaries };
        for (const id of unsentIds.current) { delete sizes[id]; delete summaries[id]; }
        onStateChange?.(storageKey, { ...next, sizes, summaries });
      } else onStateChange?.(storageKey, next);
    },
    [onStateChange, storageKey, readOnly, rememberUndo],
  );
  const canUndo = !!entry && !readOnly && !busy && !history && (!('undoId' in entry) || !!historyActions);
  async function undoLast() {
    if (!entry || !canUndo || historyBusy.current || pendingUndo.current) return;
    pendingUndo.current = true;
    setBusy(true);
    setActionError(null);
    try {
      if ('undoId' in entry) {
        await historyActions!.undo(entry.undoId);
        if (!mounted.current) return;
        setConsumed(entry.undoId);
      } else {
        const next = entry.undo(latestStateRef.current);
        const moves = new Map(entry.draftMoves?.map(m => [m.id, m]));
        for (const draft of childDrafts) {
          const move = moves.get(draft.id);
          if (move && (draft.point.x !== move.after.x || draft.point.y !== move.after.y))
            throw Error('子卡位置已变，未覆盖新位置。');
        }
        if (moves.size) setChildDrafts(ds => ds.map(d => moves.has(d.id) ? {...d, point: moves.get(d.id)!.before} : d));
        commit(next);
      }
      setUndoStack(s => s.filter(item => item !== entry));
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : '未确认撤销结果。请检查原对话。');
    } finally {
      pendingUndo.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const visible = useMemo(
    () => (visibleIds ? nodes.filter((n) => visibleIds.has(n.id)) : nodes),
    [nodes, visibleIds],
  );
  useEffect(() => {
    setReferenceDrafts(ds => {
      const valid = ds.filter(d => nodeById.has(d.sourceId) && (!d.drop || nodeById.has(d.drop.targetId)));
      return valid.length === ds.length ? ds : valid;
    });
  }, [nodeById, visible]);
  const family = fullFamilyNodes ?? nodes;
  const familyIds = useMemo(() => new Set(family.map(n => n.id)), [family]);
  // Do not mutate saved metadata: undo may restore the exact native IDs. A pending
  // child needs a live parent, not a projected child (its first answer may still be in flight).
  const activeReferences = useMemo(() => state.references.filter(r => familyIds.has(r.fromNodeId) && familyIds.has(r.toNodeId)), [familyIds, state.references]);
  const pending = useMemo(() => state.pendingBranches?.filter(d => familyIds.has(d.parentId)), [familyIds, state.pendingBranches]);
  const draftNodes = useMemo(() => [...childDrafts.filter(d => familyIds.has(d.parentId)), ...(pending ?? [])], [childDrafts, familyIds, pending]);
  const visibleDrafts = useMemo(
    () => draftNodes.filter((d) => !visibleIds || visibleIds.has(d.parentId)),
    [draftNodes, visibleIds],
  );
  const visualNodes = useMemo(() => [...visible, ...visibleDrafts], [visible, visibleDrafts]);
  const positions = useMemo(
    () => ({
      ...state.positions,
      ...Object.fromEntries(draftNodes.map((d) => [d.id, d.point])),
      ...transient,
    }),
    [state.positions, transient, draftNodes],
  );
  const sizes = useMemo(() => sizePreview ? { ...state.sizes, [sizePreview.id]: sizePreview.size } : state.sizes, [sizePreview, state.sizes]);
  const asideTurns = useMemo(() => new Map(family.filter(n => n.side && n.userMessageId)
    .map(n => [JSON.stringify([n.sessionId, n.userMessageId]), n])), [family]);
  useEffect(() => {
    const latest = latestStateRef.current;
    if (!latest.asides || readOnly) return;
    // Once projected, the native row owns the display text. Deleted/rewound turns
    // must not reappear as accepted placeholders on reopening the graph.
    let changed = false;
    const asides = latest.asides.map(a => {
      if (a.projected || !asideTurns.has(JSON.stringify([a.sessionId, a.userMessageId]))) return a;
      changed = true; return { ...a, projected: true as const, question: '' };
    });
    if (changed) commit({ ...latest, asides });
  }, [asideTurns, state.asides, readOnly, commit]);
  const asideEntries = useMemo(() => {
    const grouped = new Map<string, DagAside[]>();
    const add = (a: DagAside) => { const group = grouped.get(a.nodeId); if (group) group.push(a); else grouped.set(a.nodeId, [a]); };
    for (const a of state.asides ?? []) if (!a.projected || asideTurns.has(JSON.stringify([a.sessionId, a.userMessageId]))) add(a);
    return grouped;
  }, [state.asides, asideTurns]);

  // Extensions affect occupied space and camera fitting, not the main card's edge ports.
  const footprintSizes = useMemo(() => {
    const result = { ...sizes };
    const extend = (id: string, extra: number) => { const size = cardSize(result, id); result[id] = { ...size, height: size.height + extra }; };
    for (const id of expandedAsides) extend(id, asidePanelHeight(asideEntries.has(id)));
    for (const id of new Set([...asideEntries.keys(), ...asideInputs.current.keys()])) if (!expandedAsides.has(id)) extend(id, 26);
    for (const draft of referenceDrafts) extend(draft.drop?.targetId ?? draft.sourceId, REFERENCE_PANEL_HEIGHT);
    return result;
  }, [sizes, expandedAsides, referenceDrafts, asideEntries]);
  const bounds = useMemo(() => contentBounds(visualNodes, positions, footprintSizes), [visualNodes, positions, footprintSizes]);

  function resizeHandle(id: string) {
    if (readOnly) return null;
    return <DagResizeHandle size={cardSize(sizes, id)}
      preview={size => setSizePreview(prev => size ? { id, size } : prev?.id === id ? null : prev)}
      finish={size => {
        if (pendingUndo.current || historyBusy.current) return;
        const resolve = () => projectedDraftIds.current.get(id) ?? id;
        const key = resolve(), latest = latestStateRef.current;
        const before = latest.sizes?.[key], previous = before ?? DEFAULT_SIZE;
        if (size.width === previous.width && size.height === previous.height) return;
        const next = { ...latest, sizes: { ...latest.sizes, [key]: size } };
        rememberUndo({ label: '调整卡片大小', metadataId: id, undo: inverseSizeEdit(resolve, before, size) });
        commit(next);
      }} />;
  }

  // Match the fork and its anchor, never another sibling with the same text.
  useEffect(() => {
    const latest = latestStateRef.current;
    if (!latest.pendingBranches?.length) return;
    let next = reconcileNodes(latest, nodes);
    const remaining = latest.pendingBranches.filter((d) => {
      // A reused session may receive many inputs. Never consume a sibling with the same text.
      // Older fork-only placeholders had no message ID and own a fresh child session.
      const requireId = d.reused || nodeById.get(d.parentId)?.sessionId === d.sessionId;
      const turn = nodes.find(n => n.sessionId === d.sessionId && n.parentId === d.parentId &&
        (d.userMessageId ? n.userMessageId === d.userMessageId : !requireId));
      if (!turn) return true;
      if (next.summaries && Object.hasOwn(next.summaries, d.id)) {
        const summaries = { ...next.summaries, [turn.id]: next.summaries[d.id] };
        delete summaries[d.id];
        next = { ...next, summaries };
      }
      next.positions[turn.id] = d.point;
      projectedDraftIds.current.set(d.id, turn.id);
      if (next.sizes?.[d.id]) {
        const sizes = { ...next.sizes, [turn.id]: next.sizes[d.id] };
        delete sizes[d.id];
        next = { ...next, sizes };
      }
      if (d.reference && !familyIds.has(d.reference.toNodeId)) {
        if (!next.references.some(r => r.id === d.reference!.id))
          next = { ...next, references: [...next.references, { ...d.reference, fromNodeId: turn.id }] };
      } else if (d.reference) {
        const added = addReference(next, {
          ...d.reference,
          fromNodeId: turn.id,
          nodes: fullFamilyNodes ?? nodes,
        });
        if (added.ok) next = added.state;
        else setActionError(added.message);
      }
      return false;
    });
    if (remaining.length !== latest.pendingBranches.length)
      commit({ ...next, pendingBranches: remaining });
  }, [nodes, nodeById, fullFamilyNodes, familyIds, pending, commit]);

  async function openHistory(node: DagNode, kind: 'delete' | 'recall') {
    if (!historyActions || readOnly || !historyReady || historyBusy.current || pendingUndo.current) return;
    setActionError(null);
    const sequence = ++previewSequence.current;
    historyBusy.current = true;
    setHistory({ node, kind, token: '', details: [], error: '', busy: false });
    try {
      const result = await historyActions.preview(node, kind);
      if (!mounted.current || previewSequence.current !== sequence) return;
      if (!result.token || !result.details.length) throw Error('未收到完整的原生操作范围。');
      setHistory({ node, kind, ...result, error: '', busy: false });
    } catch (error) {
      if (mounted.current && previewSequence.current === sequence)
        setHistory({ node, kind, token: '', details: [], busy: false, error: error instanceof Error ? error.message : '无法核对操作范围' });
    } finally {
      if (previewSequence.current === sequence) historyBusy.current = false;
    }
  }
  async function confirmHistory() {
    if (!history || history.busy || !history.token || !historyActions || historyBusy.current || readOnly || !historyReady) return;
    const current = nodeById.get(history.node.id);
    if (!current || current.sessionId !== history.node.sessionId || current.userMessageId !== history.node.userMessageId) {
      setHistory({ ...history, token: '', error: '原问题已经变化。请取消后重新查看范围。' });
      return;
    }
    historyBusy.current = true;
    setHistory({ ...history, busy: true, error: '' });
    try {
      const result = await historyActions.commit(history.node, history.kind, history.token);
      if (!mounted.current) return;
      if (!result?.undoId) throw Error('未获得宿主操作回执，请核对原对话。');
      rememberUndo({undoId: result.undoId, label: history.kind === 'delete' ? '删除分支' : '撤回提问'});
      setHistory(null);
    } catch (error) {
      if (mounted.current)
        setHistory({ ...history, token: '', busy: false,
          error: error instanceof Error ? error.message : '操作未确认，请核对原对话后重新预览。' });
    } finally { historyBusy.current = false; }
  }

  const histories = useMemo(() => {
    const byNode = new Map<string, typeof state.revisions>();
    for (const revision of state.revisions) {
      const history = byNode.get(revision.nodeId);
      if (history) history.push(revision);
      else byNode.set(revision.nodeId, [revision]);
    }
    return new Map(family.map((n) => [n.id, listVersions(n, byNode.get(n.id) ?? [])]));
  }, [family, state.revisions]);
  const selectedVersionOf = useCallback(
    (id: string) => {
      const versions = histories.get(id);
      return versions?.find((v) => v.key === selectedVersions[id]) ?? versions?.[0];
    },
    [histories, selectedVersions],
  );
  const projectSelected = useCallback(
    (node: DagNode) => {
      const v = selectedVersionOf(node.id);
      return v?.manual ? projectNode(node, v.question, v.answer) : node;
    },
    [selectedVersionOf],
  );
  const projectedNodes = useMemo(() => nodes.map(projectSelected), [nodes, projectSelected]);
  const archiveNodes = useMemo(
    () =>
      family === nodes || (family.length === nodes.length && family.every((n, i) => n === nodes[i]))
        ? projectedNodes
        : family.map(projectSelected),
    [family, nodes, projectedNodes, projectSelected],
  );
  const startReference = useCallback(
    (sourceId: string, drop?: { targetId: string }) => {
      const version = selectedVersionOf(sourceId);
      if (!version) return;
      setActionError(null);
      const draft: ReferenceDraft = {
        operationId: nextId('question'),
        sourceId,
        drop,
        snapshot: {
          sourceVersion: version.key,
          question: version.question,
          summary: `${version.manual ? `${copy.card.manualRevision}：` : ''}${summarizeAnswer(version.answer)}`,
        },
      };
      setReferenceDrafts(ds => [...ds, draft]);
    },
    [selectedVersionOf],
  );

  const movedCard = (
    drag: Extract<DragState, { kind: 'card' }>,
    e: PointerEvent,
  ): Record<string, DagPoint> => {
    const entries =
      drag.branch || e.shiftKey
        ? Object.entries(drag.origins)
        : [[drag.nodeId, drag.origins[drag.nodeId]] as const];
    const dx = (e.clientX - drag.startX) / drag.k,
      dy = (e.clientY - drag.startY) / drag.k;
    return Object.fromEntries(entries.map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
  };
  const handleCardPointerDown = (nodeId: string, e: ReactPointerEvent<HTMLElement>) => {
    if (drag || !positions[nodeId]) return;
    suppressedClick.current = null;
    travelled.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const origins: Record<string, DagPoint> = Object.create(null);
    const children = new Map<string, string[]>();
    for (const n of [...nodes, ...draftNodes])
      if (n.parentId) {
        const ids = children.get(n.parentId) ?? [];
        ids.push(n.id);
        children.set(n.parentId, ids);
      }
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      if (origins[id] || !positions[id]) continue;
      origins[id] = positions[id];
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    if (nodeById.has(nodeId)) setSelectedNodeId(nodeId);
    setDrag({
      kind: 'card',
      nodeId,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      k: Number(surface.current?.dataset.dagScale) || 1,
      origins,
      branch: e.shiftKey,
    });
  };
  const startPort = (nodeId: string, e: ReactPointerEvent<HTMLButtonElement>, tap: () => void) => {
    const el = surface.current;
    if (!el || drag || readOnly) return;
    const box = e.currentTarget.getBoundingClientRect();
    const origin = el.getBoundingClientRect();
    const k = Number(el.dataset.dagScale) || 1;
    travelled.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setSelectedNodeId(nodeId);
    setDrag({
      kind: 'branch',
      tap,
      nodeId,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      k,
      anchor: {
        x: (box.left + box.width / 2 - origin.left) / k,
        y: (box.top + box.height / 2 - origin.top) / k,
      },
    });
  };
  useEffect(() => {
    if (!drag) return;
    const cancel = () => {
      setTransient(null);
      setDrag(null);
    };
    const abort = () => {
      if (drag.kind === 'card') suppressedClick.current = drag.nodeId;
      cancel();
    };
    const isDrag = (e: PointerEvent) =>
      (travelled.current ||= Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 4);
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== drag.id || !isDrag(e)) return;
      if (drag.kind === 'card') {
        setTransient(movedCard(drag, e));
        return;
      }
      const box = surface.current?.getBoundingClientRect();
      if (!box || !dragLine.current) return;
      const hit = document
        .elementFromPoint?.(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-session-dag-card]');
      if (hit && surface.current?.contains(hit) && hit.dataset.sessionDagCard !== drag.nodeId)
        dragLine.current.setAttribute('stroke-dasharray', '6 5');
      else dragLine.current.removeAttribute('stroke-dasharray');
      dragLine.current.setAttribute(
        'x2',
        String((e.clientX - box.left) / (Number(surface.current?.dataset.dagScale) || 1)),
      );
      dragLine.current.setAttribute(
        'y2',
        String((e.clientY - box.top) / (Number(surface.current?.dataset.dagScale) || 1)),
      );
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== drag.id) return;
      const latest = latestStateRef.current;
      const tap = !isDrag(e);
      if (drag.kind === 'card') {
        if (!tap) {
          suppressedClick.current = drag.nodeId;
          const moved = movedCard(drag, e);
          const next = { ...latest.positions };
          for (const [id, point] of Object.entries(moved))
            if (Object.hasOwn(next, id)) next[id] = point;
          setChildDrafts((ds) => ds.map((d) => (moved[d.id] ? { ...d, point: moved[d.id] } : d)));
          commit({
            ...latest,
            positions: next,
            ...(latest.pendingBranches && {
              pendingBranches: latest.pendingBranches.map((d) =>
                moved[d.id] ? { ...d, point: moved[d.id] } : d,
              ),
            }),
          }, '移动卡片', childDrafts.flatMap(d => moved[d.id] ? [{id: d.id, before: d.point, after: moved[d.id]}] : []));
        }
      } else {
        if (tap) drag.tap();
        else if (!readOnly && nodeById.has(drag.nodeId)) {
          const el = surface.current;
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const card = hit?.closest<HTMLElement>('[data-session-dag-card]');
          const target = card?.dataset.sessionDagCard;
          if (el && card && target && el.contains(card) && nodeById.has(target)) {
            if (target === drag.nodeId) openAside(target);
            else { setSelectedNodeId(target); startReference(drag.nodeId, { targetId: target }); }
          }
          // Blank area can extend beyond the transformed content surface.
          if (el && (hit === el || hit === el.parentElement)) {
            const box = el.getBoundingClientRect();
            const k = Number(el.dataset.dagScale) || 1;
            const point = { x: (e.clientX - box.left) / k, y: (e.clientY - box.top) / k };
            const draft = { id: nextId('draft'), parentId: drag.nodeId, point, question: '' };
            unsentIds.current.add(draft.id);
            setChildDrafts((ds) => [...ds, draft]);
          }
        }
      }
      cancel();
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === drag.id) abort();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') abort();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', abort);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', abort);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, family, commit, nodeById, readOnly, startReference, openAside, childDrafts]);

  function saveSummary(id: string, summary: string) {
    const latest = latestStateRef.current;
    const summaries = { ...latest.summaries };
    if (summary) summaries[id] = summary; else delete summaries[id];
    commit({ ...latest, summaries }, '修改节点名', undefined, id);
  }

  const actionDraft = useCallback(
    (nodeId: string, action: DagActionKind) => {
      const node = nodeById.get(nodeId);
      const version = selectedVersionOf(nodeId);
      if (!node || !version) return;
      const summary =
        version.manual && action !== 'retry'
          ? version.nativeAnswer ? `问题勘误：${version.question}` : `${copy.card.manualRevision}：${version.question}\n${version.answer}`
          : '';
      const context =
        action === 'retry'
          ? ''
          : buildAdvanceContext(summary, activeReferences, nodeId);
      const question = action === 'retry' ? version.question : '';
      return { question, context };
    },
    [nodeById, selectedVersionOf, activeReferences],
  );

  async function confirmReference(referenceDraft: ReferenceDraft, target: DagNode, snapshot: ReferenceSnapshot, question: string) {
    const source = referenceDraft.sourceId;
    const origin = nodeById.get(target.id);
    const version = selectedVersionOf(target.id);
    if (
      readOnly ||
      !source ||
      source === target.id ||
      !nodeById.has(source) ||
      !origin ||
      !version ||
      !question.trim() ||
      !snapshot.summary.trim()
    )
      return false;
    // The consumer is a new child of the drop target, not the drop target itself.
    const context = buildAdvanceContext(
      version.manual
        ? version.nativeAnswer ? `问题勘误：${version.question}` : `${copy.card.manualRevision}：${version.question}\n${version.answer}`
        : '',
      activeReferences.filter((r) => r.toNodeId !== source),
      origin.id,
    );
    const result = await onAction(
      projectNode(origin, version.question, version.answer),
      'advance',
      {
        question: question.trim(),
        branchQuestionId: JSON.stringify([referenceDraft.operationId, target.id]),
        context: [context, `引用快照（${snapshot.question}）：${snapshot.summary.trim()}`]
          .filter(Boolean)
          .join('\n'),
      },
    );
    const receipt = acceptedTarget(result, origin);
    if (!mounted.current || !receipt) return false;
    const latest = latestStateRef.current;
    const id = nextId('draft');
    const point = availableChildPoint(target.id);
    const reference = {
      includedInQuestion: true as const,
      id: nextId('ref'),
      createdAt: Date.now(),
      fromNodeId: id,
      toNodeId: source,
      snapshot: { ...snapshot, summary: snapshot.summary.trim() },
    };
    commit({
      ...latest,
      pendingBranches: [
        ...(latest.pendingBranches ?? []),
        {
          id,
          parentId: target.id,
          point,
          question: question.trim(),
          ...receipt,
          reference,
        },
      ],
    });
    closeReference(referenceDraft.operationId);
    return true;
  }

  function availableChildPoint(parentId: string) {
    const latest = latestStateRef.current, anchor = latest.positions[parentId] ?? positions[parentId];
    const occupied = { ...positions, ...latest.positions, ...Object.fromEntries((latest.pendingBranches ?? []).map(d => [d.id, d.point])) };
    const point = { x: anchor.x + cardSize(latest.sizes, parentId).width + CARD_GAP_X, y: anchor.y };
    for (const [id, p] of Object.entries(occupied).sort((a, b) => a[1].y - b[1].y)) {
      const size = cardSize(footprintSizes, id);
      if (point.x < p.x + size.width + 12 && p.x < point.x + DEFAULT_SIZE.width + 12 &&
          point.y < p.y + size.height + 12 && p.y < point.y + DEFAULT_SIZE.height + 12) point.y = p.y + size.height + CARD_GAP_Y;
    }
    return point;
  }

  function startInlineAction(nodeId: string, action: DagActionKind) {
    if (readOnly || !nodeById.has(nodeId)) return;
    if (action === 'aside') return openAside(nodeId);
    if (action !== 'advance') return;
    const point = availableChildPoint(nodeId), id = nextId('draft');
    unsentIds.current.add(id);
    setChildDrafts(ds => [...ds, { id, parentId: nodeId, point, question: '' }]);
  }

  async function sendFromCard(node: DagNode, kind: 'aside' | 'retry', question: string, operation: string) {
    if (readOnly || !question.trim()) throw Error('当前不能从此卡提问。');
    const draft = actionDraft(node.id, kind);
    if (!draft) throw Error('未找到这次提问的历史位置。');
    if (kind === 'retry' && node.runState === 'failed' && question.trim() === node.question.trim()) {
      if (!onRetryFailed) throw Error('当前不能重试原问题。');
      await onRetryFailed(node); return;
    }
    const result = await onAction(projectSelected(node), kind, { ...draft, question, branchQuestionId: operation });
    if (!mounted.current) return;
    const receipt = acceptedTarget(result, node);
    if (!receipt || receipt.reused || !receipt.userMessageId) throw Error('未取得这次提问的原生受理回执；已保留输入。');
    if (kind === 'aside') {
      const latest = latestStateRef.current;
      const row: DagAside = { id: operation, nodeId: node.id, question, sessionId: receipt.sessionId, userMessageId: receipt.userMessageId };
      if (!latest.asides?.some(a => a.sessionId === row.sessionId && a.userMessageId === row.userMessageId)) {
        commit({ ...latest, asides: [...(latest.asides ?? []), row] });
      }
    }
  }


  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col" onKeyDown={e => {
      if (!canUndo || !e.currentTarget.contains(e.target as Node) || e.repeat || e.defaultPrevented ||
          !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' ||
          (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=dialog],[role=menu]'))) return;
      e.preventDefault();
      e.stopPropagation();
      void undoLast();
    }}>
      <div className="absolute left-3 top-2 z-10 flex items-start gap-1">
        <DagGraphTools
          nodes={projectedNodes}
          originalNodes={family}
          archiveNodes={archiveNodes}
          historyReady={historyReady}
          canvasState={{ ...state, references: activeReferences, pendingBranches: pending }}
          selectedVersions={selectedVersions}
          labels={state.labels ?? emptyLabels}
          selectedId={selectedNodeId}
          undoLabel={entry?.label}
          onUndo={canUndo ? () => void undoLast() : undefined}
          onDelete={historyActions && historyReady && !readOnly ? id => { const n = nodeById.get(id); if (n) void openHistory(n, 'delete'); } : undefined}
          onVisible={setVisibleIds}
          onLabel={(id, label) => {
            const latest = latestStateRef.current;
            const labels = { ...latest.labels, [id]: label };
            if (!label) delete labels[id];
            commit({ ...latest, labels }, '修改标签');
          }}
          onFocus={(id) => {
            if (positions[id]) {
              setSelectedNodeId(id);
              const box = cardSize(sizes, id);
              navigator.current?.({ x: positions[id].x + box.width / 2, y: positions[id].y + box.height / 2 });
            }
          }}
        />
      </div>
      {actionError && (
        <div
          role="alert"
          className="absolute bottom-14 left-3 z-10 rounded-lg border border-border bg-popover p-2 text-12 text-[var(--text-danger)]"
        >
          {actionError}
          <button
            type="button"
            aria-label="关闭提示"
            className="ml-2"
            onClick={() => setActionError(null)}
          >
            ×
          </button>
        </div>
      )}
      <DagViewport
        onOpenChat={onOpenChat}
        nodes={visualNodes}
        positions={positions}
        sizes={footprintSizes}
        surface={surface}
        bounds={bounds}
        navigatorRef={navigator}
        tidy={() => {
          if (readOnly) return bounds;
          const next = autoLayout([...nodes, ...draftNodes], footprintSizes), latest = latestStateRef.current;
          const moves = childDrafts.flatMap(d => next[d.id] ? [{ id: d.id, before: d.point, after: next[d.id] }] : []);
          setChildDrafts(ds => ds.map(d => next[d.id] ? { ...d, point: next[d.id] } : d));
          commit({ ...latest, positions: { ...latest.positions, ...Object.fromEntries(nodes.map(n => [n.id, next[n.id]])) },
            ...(latest.pendingBranches && { pendingBranches: latest.pendingBranches.map(d => next[d.id] ? { ...d, point: next[d.id] } : d) }) }, '整理布局', moves);
          return contentBounds(visualNodes, next, footprintSizes);
        }}
      >
        <DagEdgeLayer
          sizes={sizes}
          nodes={visualNodes}
          positions={positions}
          references={[
            ...activeReferences.filter(
              (r) => !visibleIds || (visibleIds.has(r.fromNodeId) && visibleIds.has(r.toNodeId)),
            ),
            ...(pending ?? []).flatMap((d) =>
              d.reference && familyIds.has(d.reference.toNodeId) &&
              (!visibleIds || (visibleIds.has(d.parentId) && visibleIds.has(d.reference.toNodeId)))
                ? [d.reference]
                : [],
            ),
          ]}
          width={bounds.width}
          height={bounds.height}
        />
        {visible.map((node) => {
          const position = positions[node.id] ?? { x: 0, y: 0 };
          return (
            <div
              key={node.id}
              className="dag-node-stack absolute"
              data-dag-selected={selectedNodeId === node.id || undefined}
              style={{
                ...{ '--dag-tail': `${cardSize(footprintSizes, node.id).height - cardSize(sizes, node.id).height}px` },
                left: position.x,
                top: position.y,
                width: cardSize(sizes, node.id).width,
                zIndex: selectedNodeId === node.id ? 1 : undefined,
              }}
            >
              <DagNodeCard
                readOnly={readOnly}
                size={cardSize(sizes, node.id)}
                resizeHandle={resizeHandle(node.id)}
                node={node}
                versions={histories.get(node.id)!}
                selectedVersionKey={selectedVersions[node.id] ?? 'origin'}
                label={state.labels?.[node.id]}
                outgoingReferences={activeReferences.filter(
                  (reference) => reference.fromNodeId === node.id,
                )}
                selected={selectedNodeId === node.id}
                onSelectVersion={(nodeId, versionKey) => {
                  const latest = latestStateRef.current;
                  commit({
                    ...latest,
                    selectedVersions: { ...latest.selectedVersions, [nodeId]: versionKey },
                  }, '切换修订');
                }}
                onOpen={(n) => {
                  setSelectedNodeId(n.id);
                  onOpen(n);
                }}
                onPin={
                  onPin &&
                  ((n) => {
                    setSelectedNodeId(n.id);
                    onPin(n);
                  })
                }
                onNudge={(id, dx, dy) => {
                  const latest = latestStateRef.current,
                    p = latest.positions[id];
                  commit(
                    setNodePosition(latest, id, {
                      x: p.x + dx,
                      y: p.y + dy,
                    }), '移动卡片',
                  );
                }}
                summary={state.summaries?.[node.id]}
                onSummaryChange={readOnly ? undefined : value => saveSummary(node.id, value)}
                onSaveQuestion={readOnly ? undefined : question => {
                  const latest = latestStateRef.current, v = selectedVersionOf(node.id);
                  if (!v || !question.trim() || question.trim() === v.question) return;
                  const id = nextId('question-edit');
                  const inheritsNative = !v.manual || v.nativeAnswer;
                  commit({ ...latest, revisions: [...latest.revisions, {
                    id, nodeId: node.id, createdAt: Date.now(), source: 'manual', question: question.trim(),
                    ...(inheritsNative ? { answer: '', nativeAnswer: true as const } : { answer: v.answer }),
                  }], selectedVersions: { ...latest.selectedVersions, [node.id]: id } }, '修改问题');
                }}
                onResubmit={readOnly ? undefined : (q, op) => sendFromCard(node, 'retry', q, op)}
                onRetryFailed={readOnly ? undefined : onRetryFailed}
                onHistory={historyActions && historyReady && !readOnly ? openHistory : undefined}
                onPreviewAction={startInlineAction}
                onStartBranchDrag={startPort}
                consumeDragClick={(id) => suppressedClick.current === id}
                onOpenReferencePicker={readOnly ? undefined : startReference}
                onRemoveReference={(referenceId) =>
                  commit(removeReference(latestStateRef.current, referenceId), '移除引用')
                }
                onCardPointerDown={handleCardPointerDown}
              />
              {expandedAsides.has(node.id) && <DagInlineAside
                entries={asideEntries.get(node.id) ?? []}
                input={asideInputs.current.get(node.id)}
                onInput={input => { if (input.question || input.operation) asideInputs.current.set(node.id, input); else asideInputs.current.delete(node.id); }}
                turns={asideTurns} readOnly={readOnly}
                onAsk={(q, op) => sendFromCard(node, 'aside', q, op)}
                onCollapse={() => setExpandedAsides(s => { const next = new Set(s); next.delete(node.id); return next; })}
              />}
              {!expandedAsides.has(node.id) && (asideEntries.has(node.id) || asideInputs.current.has(node.id)) &&
                <button type="button" className="dag-extension dag-reopen-aside" onClick={() => openAside(node.id)}>展开旁问</button>}
              {referenceDrafts.filter(d => (d.drop?.targetId ?? d.sourceId) === node.id).map(d => <DagInlineReference
                key={d.operationId} targetId={d.drop?.targetId} snapshot={d.snapshot} readOnly={readOnly}
                candidates={projectedNodes.filter(n => n.id !== d.sourceId)} onCancel={() => closeReference(d.operationId)}
                onAsk={(target, snapshot, question) => confirmReference(d, target, snapshot, question)}
              />)}
            </div>
          );
        })}
        {visibleDrafts.map((d) => (
          <ChildDraftCard
            size={cardSize(sizes, d.id)}
            resizeHandle={resizeHandle(d.id)}
            key={d.id}
            id={d.id}
            onDragBlank={handleCardPointerDown}
            parentId={d.parentId}
            point={positions[d.id]}
            question={d.question}
            summary={state.summaries?.[d.id]}
            onSummaryChange={readOnly ? undefined : value => saveSummary(d.id, value)}
            readOnly={readOnly || !nodeById.has(d.parentId)}
            status={
              'sessionId' in d
                ? d.delivery === 'accepted'
                  ? (d.reused ? 'continued' : 'accepted')
                  : 'legacy-draft'
                : 'editing'
            }
            onOpen={() => {
              if ('sessionId' in d && typeof d.sessionId === 'string')
                onOpenPrepared?.(d.sessionId);
            }}
            onChange={(question) =>
              setChildDrafts((ds) =>
                ds.map((old) => (old.id === d.id ? { ...old, question } : old)),
              )
            }
            onCancel={() => {
              const latest = latestStateRef.current;
              if (latest.sizes?.[d.id] || latest.summaries?.[d.id]) {
                const sizes = { ...latest.sizes }, summaries = { ...latest.summaries };
                delete sizes[d.id]; delete summaries[d.id]; commit({ ...latest, sizes, summaries });
              }
              unsentIds.current.delete(d.id);
              setUndoStack(stack => stack.filter(item => !('metadataId' in item) || item.metadataId !== d.id));
              setChildDrafts(ds => ds.filter(old => old.id !== d.id));
            }}
            onAsk={async () => {
              const parent = nodeById.get(d.parentId),
                version = selectedVersionOf(d.parentId);
              const draft = actionDraft(d.parentId, 'advance');
              if (!parent || !version || !draft || readOnly) return;
              setActionError(null);
              const result = await onAction(
                projectNode(parent, version.question, version.answer),
                'advance',
                { ...draft, question: d.question, branchQuestionId: d.id },
              );
              if (!mounted.current) return;
              const receipt = acceptedTarget(result, parent);
              if (!receipt) {
                setActionError(copy.branch.noReceipt);
                return;
              }
              unsentIds.current.delete(d.id);
              const latest = latestStateRef.current;
              commit({
                ...latest,
                pendingBranches: [
                  ...(latest.pendingBranches ?? []),
                  { ...d, ...receipt },
                ],
              });
              setChildDrafts((ds) => ds.filter((old) => old.id !== d.id));
            }}
            onError={(error) =>
              setActionError(error instanceof Error ? error.message : copy.branch.noReceipt)
            }
          />
        ))}
        {drag && drag.kind !== 'card' && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          >
            <line
              ref={dragLine}
              x1={drag.anchor.x}
              y1={drag.anchor.y}
              x2={drag.anchor.x}
              y2={drag.anchor.y}
              stroke="currentColor"
              strokeWidth={2}
            />
          </svg>
        )}
      </DagViewport>

      {history && (
        <NativeHistoryDialog
          kind={history.kind}
          details={history.details}
          canConfirm={!!history.token && !readOnly && historyReady && !!historyActions}
          requiresStop={history.requiresStop}
          error={history.error}
          busy={history.busy}
          onCancel={() => { ++previewSequence.current; historyBusy.current = false; setHistory(null); }}
          onConfirm={() => void confirmHistory()}
        />
      )}

    </div>
  );
}

export type { DagNode, DagCanvasState, SessionDagCanvasProps } from './types';
