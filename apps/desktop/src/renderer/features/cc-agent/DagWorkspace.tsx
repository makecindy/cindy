import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { PanelRightClose, PanelRightOpen, Pin, PinOff } from 'lucide-react';
import { forkAtMessage } from '@/lib/sessionService';
import { useDagHistoryActions } from './useDagHistoryActions';
import { createDagFailedRetry, type DagFailedRetry } from './DagFailedRetry';
import { createDagChildSend, hasDagTargetDraft, type DagChildSend } from './DagChildSend';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { isSharedTaskPeer } from '@cindy/device-link';
import { isRemoteSessionWriteBlocked } from './lib/remoteSessionWriteGuard';
import { toast } from '@/lib/toast';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { SessionDagCanvas } from './session-dag/SessionDagCanvas';
import type { ActionDraft, DagActionKind, DagCanvasState, DagNode } from './session-dag/types';
import { dagAnswerPosition, useDagFamilyTurns } from './useDagFamilyTurns';

interface Pane {
  id: string;
  label: string;
  jump: ConversationSearchJump | null;
}
interface Props {
  session: Session;
  sessions: readonly Session[];
  messages: readonly ChatMessage[];
  readOnly: boolean;
  refresh: () => void;
  renderChat: (pane: Pane, onConsumed: () => void, submission?: DagChildSend, retry?: DagFailedRetry, background?: boolean) => ReactNode;
}
class UnconfirmedBranchSend extends Error {
  constructor(creationUnknown = false) {
    super(creationUnknown ? '未确认历史分支是否已创建。请核对原生对话；本次没有发送问题，不会重复分叉。' :
      '未确认问题是否送达。请在目标分支核对消息；不会再次发送。');
  }
}
const writes = new Map<string, Promise<void>>();
const iconButton =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2';
async function diskKey(scope: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  return (
    'dag_state_' +
    Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('')
  );
}
type Replacement = readonly [string, string, string, string];
function isReplacement(value: unknown): value is Replacement {
  return Array.isArray(value) && value.length === 4 && value.every(id => typeof id === 'string' && id.length > 0);
}
function write(key: string, state: DagCanvasState | undefined, asideSessions: ReadonlySet<string>, retryLinks: readonly Replacement[]) {
  const snapshot = JSON.stringify({ version: 1, canvas: state, asideSessions: [...asideSessions], retryLinks });
  const owner = getDataOwnerGeneration();
  const next = (writes.get(key) ?? Promise.resolve())
    .then(async () => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!(await window.electronAPI.safeStorageStore(key, snapshot)))
        throw new Error('无法保存画布');
    })
    .catch(() => {
      toast.error('画布修改未保存；原生聊天记录未改变。');
    });
  writes.set(key, next);
  void next.then(() => {
    if (writes.get(key) === next) writes.delete(key);
  });
}
export function DagWorkspace({
  session,
  sessions,
  messages,
  readOnly,
  refresh,
  renderChat,
}: Props) {
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const [pinnedPane, setPinned] = useState<Pane | null>(null);
  const [savedRetries, setSavedRetries] = useState<{ scope: string; rows: Replacement[] }>();
  const retryLinks = useRef<Replacement[]>([]);
  const [panes, setPanes] = useState<Pane[]>(() => [{ id: session.id, label: '主线', jump: null }]);
  const trackedIds = useMemo(() => panes.map(p => p.id), [panes]);
  const graph = useDagFamilyTurns(true, session.id, sessions, messages, revision, active ?? undefined, pinnedPane?.id, savedRetries, trackedIds);
  const awaitingList = useRef(new Set<string>());
  const familyIds = useMemo(() => new Set(graph.family.map(b => b.id)), [graph.family]);
  useLayoutEffect(() => {
    for (const id of awaitingList.current) if (sessions.some(s => s.id === id)) awaitingList.current.delete(id);
  }, [sessions]);
  const pinned = pinnedPane && (familyIds.has(pinnedPane.id) || awaitingList.current.has(pinnedPane.id)) ? pinnedPane : null;
  const scope =
    graph.rootId &&
    JSON.stringify([session.userId, session.deviceLinkDeviceId ?? 'local', graph.rootId]);
  const [loaded, setLoaded] = useState<{
    scope: string;
    key: string;
    state?: DagCanvasState;
  } | null>(null);
  const [error, setError] = useState('');
  const [asideIds, setAsideIds] = useState<ReadonlySet<string>>(new Set());
  const lastCanvas = useRef<DagCanvasState | undefined>(undefined);
  const sideRef = useRef<ReadonlySet<string>>(new Set());
  const [showPinned, setShowPinned] = useState(false);
  const locks = useRef(new Set<string>());
  const [busy, setBusy] = useState(0);
  const ports = useRef(new Map<string, { submission?: DagChildSend; retry?: DagFailedRetry }>());
  const [, renderPorts] = useState(0);
  type Attempt = { id: string; reused: boolean; status: 'created' | 'accepted' | 'unknown'; userMessageId?: string };
  const attempts = useRef(new Map<string, Attempt>());
  useLayoutEffect(() => () => {
    for (const { submission, retry } of ports.current.values()) { submission?.cancel(); retry?.cancel(); }
    ports.current.clear();
  }, []);
  function acquire(id: string) {
    if (locks.current.has(id) || ports.current.has(id)) return false;
    locks.current.add(id); setBusy(v => v + 1); return true;
  }
  function release(id: string) {
    locks.current.delete(id); if (live.current) setBusy(v => v - 1);
  }
  function mountPort(id: string, port: { submission?: DagChildSend; retry?: DagFailedRetry }) {
    if (ports.current.has(id)) throw Error('该分支正在接收另一个操作。');
    ports.current.set(id, port); renderPorts(v => v + 1);
    return () => {
      if (ports.current.get(id) === port) ports.current.delete(id);
      if (live.current) renderPorts(v => v + 1);
    };
  }
  const writableScope = useRef<string | null>(null);
  useLayoutEffect(() => {
    writableScope.current = readOnly ? null : scope;
    return () => {
      writableScope.current = null;
    };
  }, [scope, readOnly]);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (scope)
      void (async () => {
        const key = await diskKey(scope);
        await writes.get(key);
        const raw = await window.electronAPI.safeStorageRead(key);
        const saved = raw == null ? null : JSON.parse(raw);
        const state: DagCanvasState | undefined =
          saved?.version === 1 ? saved.canvas : (saved ?? undefined);
        if (
          state &&
          (!Array.isArray(state.references) || !Array.isArray(state.revisions) || !state.positions)
        )
          throw Error('无法识别画布存档');
        if (!cancelled) {
          const sides = new Set<string>(
            (Array.isArray(saved?.asideSessions) ? saved.asideSessions : []).filter(
              (id: unknown) => typeof id === 'string',
            ),
          );
          retryLinks.current = Array.isArray(saved?.retryLinks) ? saved.retryLinks.filter(isReplacement) : [];
          setSavedRetries({ scope, rows: retryLinks.current });
          sideRef.current = sides;
          setAsideIds(sides);
          lastCanvas.current = state;
          setLoaded({ scope, key, state });
        }
      })().catch(() => {
        if (!cancelled) setError('画布存档读取失败；为保护原存档，未写入新内容。');
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);
  function makePane(id: string, label: string, message?: string): Pane {
    const jump: ConversationSearchJump | null = message
      ? {
          kind: 'conversation-search',
          sessionId: id,
          messageId: message,
          messageClientId: message,
          messageIdKind: 'clientId',
        }
      : null;
    return { id, label: id === session.id ? '主线' : label, jump };
  }
  function remember(pane: Pane) {
    setPanes(prev => prev.some(p => p.id === pane.id)
      ? prev.map(p => p.id === pane.id ? pane : p) : [...prev, pane]);
  }
  function open(id: string, label: string, message?: string) {
    const next = makePane(id, label, message);
    remember(next);
    if (id === pinned?.id) {
      setPinned(next);
      setShowPinned(true);
    } else {
      setActive(id);
      setShowPinned(false);
    }
  }
  // The family is parent-first. An entire side conversation stays out of the
  // main layout, including ordinary native forks made below a side question.
  const sideSessions = useMemo(() => {
    const result = new Set(asideIds);
    for (const branch of graph.family) {
      if (branch.source === 'side-chat' || (branch.parentSessionId && result.has(branch.parentSessionId))) result.add(branch.id);
    }
    return result;
  }, [graph.family, asideIds]);
  const fullFamilyNodes = useMemo(() => graph.nodes.map(n => sideSessions.has(n.sessionId) && !n.side ? { ...n, side: true } : n), [graph.nodes, sideSessions]);
  const nodes = useMemo(() => fullFamilyNodes.filter(n => !n.side), [fullFamilyNodes]);
  const tabs = useMemo(() => [
    ...panes.filter(p => familyIds.has(p.id) || awaitingList.current.has(p.id)),
    ...graph.family.filter(b => sideSessions.has(b.id) && !panes.some(p => p.id === b.id))
      .map(b => ({ id: b.id, label: sessions.find(s => s.id === b.id)?.title || '旁问', jump: null })),
  ], [panes, familyIds, graph.family, sideSessions, sessions]);
  const latestSessions = useRef(sessions);
  const latestFamilyIds = useRef(familyIds);
  useLayoutEffect(() => {
    latestSessions.current = sessions;
    latestFamilyIds.current = familyIds;
  }, [sessions, familyIds]);
  function branchGuard(node: DagNode) {
    const branch = graph.family.find(b => b.id === node.sessionId);
    const owner = getDataOwnerGeneration();
    const current = () => {
      const target = latestSessions.current.find(s => s.id === node.sessionId);
      return live.current && writableScope.current === scope && latestFamilyIds.current.has(node.sessionId) &&
        isDataOwnerGenerationCurrent(owner) && !!branch && !!target &&
        target.userId === session.userId && target.status === 'active' && !target.hiddenAt &&
        (target.remoteHostId ?? null) === (session.remoteHostId ?? null) &&
        target.deviceLinkDeviceId === branch.deviceLinkDeviceId && getSessionDeviceId(target.id) === target.deviceLinkDeviceId &&
        !isSharedTaskPeer(target.deviceLinkDeviceId ?? '') && !isRemoteSessionWriteBlocked(target);
    };
    return { branch, owner, current };
  }
  async function retryFailed(node: DagNode) {
    const { current } = branchGuard(node);
    const tip = graph.nodes.findLast(n => n.sessionId === node.sessionId);
    if (!scope || !current() || !node.userMessageId || tip?.id !== node.id ||
        tip.userMessageId !== node.userMessageId || tip.runState !== 'failed') {
      setError('只能重试可写分支当前失败的一轮，未创建新卡。');
      return;
    }
    if (!acquire(node.sessionId)) return;
    setError('');
    const request = createDagFailedRetry(node.sessionId, node.userMessageId, current);
    const detach = mountPort(node.sessionId, { retry: request });
    try {
      const target = makePane(node.sessionId, node.question.slice(0, 24) || '对话');
      setPanes(prev => prev.some(p => p.id === target.id) ? prev : [...prev, target]);
      const result = await request.receipt;
      if (!current()) return;
      if (result === 'accepted') {
        const link = request.replacement;
        if (link && loaded?.scope === scope) {
          const rows = [...retryLinks.current.filter(r => r[0] !== node.sessionId || r[1] !== link.clientId),
            [node.sessionId, link.clientId, link.source, link.replaces] as const];
          retryLinks.current = rows;
          setSavedRetries({ scope, rows });
          write(loaded.key, lastCanvas.current, sideRef.current, rows);
        }
        setRevision(v => v + 1);
      } else if (result === 'unknown') setError('未确认是否已开始重试。请查看原对话，不会自动重发。');
      else setError('当前不能就地重试。请查看原对话中的错误提示，未创建新卡。');
    } finally {
      // The projection callback (or timeout) can precede completion of the native retry.
      await request.whenIdle();
      detach(); release(node.sessionId);
    }
  }
  async function prepare(node: DagNode, action: DagActionKind, draft: ActionDraft) {
    if (!scope || writableScope.current !== scope ||
        !graph.nodes.some(n => n.id === node.id && n.sessionId === node.sessionId)) return false as const;
    const { branch, owner, current } = branchGuard(node);
    if (!branch || !current()) {
      setError('当前会话不可写，未准备草稿。');
      return false as const;
    }
    const selected = graph.nodes.find(n => n.id === node.id)!;
    if (!draft.branchQuestionId?.trim()) {
      setError('请显式确认后再提交问题。');
      return false as const;
    }
    if (action === 'retry' && selected.runState === 'failed' && draft.question.trim() === selected.question.trim()) {
      setError('原问题未修改，请使用失败卡的原生重试。');
      return false as const;
    }
    const anchor = action === 'retry' ? selected.userMessageId : selected.answerMessageId;
    if (node.userMessageId !== selected.userMessageId || (action !== 'retry' && node.answerMessageId !== anchor)) {
      setError('原生历史已变化，请重新选择问题或回答。');
      return false as const;
    }
    if (!anchor || !draft.question.trim()) {
      setError('需要完整的问题和可定位的历史消息。');
      return false as const;
    }
    const operation = JSON.stringify([branch.id, action, draft.branchQuestionId]);
    if (!acquire(operation)) return false as const;
    setError('');
    try {
      const text = draft.context.trim()
        ? `${draft.question}\n\n【引用资料】\n${draft.context}`
        : draft.question;
      if (graph.error || !selected.userMessageId) throw Error('无法核实这张卡在原分支中的位置。');
      const key = JSON.stringify([scope, branch.id, action, draft.branchQuestionId]);
      let attempt = attempts.current.get(key);
      const accepted = (a: Attempt) => ({ sessionId: a.id, delivery: 'accepted' as const,
        ...(a.userMessageId && {userMessageId:a.userMessageId}), ...(a.reused && {reused:true as const}) });
      if (attempt?.status === 'accepted') return accepted(attempt);
      if (attempt?.status === 'unknown') throw new UnconfirmedBranchSend(!attempt.id);
      const position = () => dagAnswerPosition(branch, anchor, selected.userMessageId);
      const idle = (ownInput?: string) => {
        const row = makerChatStore.getSnapshot(branch.id);
        return !row.agentStatus.isRunning && !row.isStreaming && !row.error && !row.inputRecovery &&
          !row.pendingQueue.some(q => q.clientId !== ownInput) &&
          !row.messages.some(m => m.clientId !== ownInput && (m.isStreaming || m.isPendingPersist));
      };
      if (!attempt) {
        const where = action === 'retry' ? 'historical' : await position();
        if (!current()) return false as const;
        if (where !== 'tip' && where !== 'historical') throw Error('无法核实所选原生回答，未发送或分叉。');
        if (action === 'advance' && where === 'tip') {
          if (branch.deviceLinkDeviceId) throw Error('远程宿主未提供末端写入校验，未发送或分叉。');
          if (!idle()) throw Error('分支末端正在运行、排队或等待恢复，请稍后再提问；不会另建分支。');
          attempt = {id:branch.id,reused:true,status:'created'};
        } else {
          const unknownFork = () => {
            attempts.current.set(key, {id:'',reused:false,status:'unknown'});
            throw new UnconfirmedBranchSend(true);
          };
          const child = await forkAtMessage(branch.id, anchor).catch((e: unknown) => {
            // A lost mutation response is not permission to create another session.
            const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
            if (['SOURCE_NOT_FOUND','MESSAGE_NOT_FOUND','NOT_USER_MESSAGE','NO_PRIOR_ASSISTANT',
              'UNSUPPORTED_HISTORY','REMOTE_NOT_SUPPORTED','PERMISSION_DENIED','INVALID_ARGUMENT',
              'NOT_FOUND','INVALID_PARAMS','SOURCE_NEVER_RAN','FORK_UNSUPPORTED_HISTORY','CODEX_FORK_STATE_UNAVAILABLE'].includes(code)) throw e;
            return unknownFork();
          });
          if (!child.id || child.id === branch.id || familyIds.has(child.id) ||
              child.parentSessionId !== branch.id || child.forkedAtMessageId !== anchor) unknownFork();
          attempt = {id:child.id,reused:false,status:'created'};
        }
        attempts.current.set(key, attempt);
      }
      if (!current()) return false as const;
      const {id, reused} = attempt;
      if (reused && !idle()) throw Error('原分支正在运行、排队或等待恢复，请稍后再提问。');
      try {
        // Track native output after the transient sender unmounts. Do not change the
        // active/fixed pane, an existing jump, or keyboard focus on explicit canvas sends.
        const tracked = makePane(id, action === 'advance' ? '推进' : action === 'aside' ? '旁问' : '重问');
        setPanes(prev => prev.some(p => p.id === id) ? prev : [...prev, tracked]);
        if (!reused) {
          if (!latestSessions.current.some(s => s.id === id)) awaitingList.current.add(id);
          if (action === 'aside' && loaded?.scope === scope && !sideRef.current.has(id)) {
            const sides = new Set(sideRef.current).add(id);
            sideRef.current = sides;
            setAsideIds(sides);
            write(loaded.key, lastCanvas.current, sides, retryLinks.current);
          }
          refresh();
          if (branch.deviceLinkDeviceId && getSessionDeviceId(id) !== branch.deviceLinkDeviceId)
            await refreshRemoteDeviceSessions(branch.deviceLinkDeviceId);
        }
        if (!current() || getSessionDeviceId(id) !== branch.deviceLinkDeviceId) throw Error('原设备或会话不可写。');
        if (locks.current.has(id) || ports.current.has(id)) throw Error('该分支正在接收另一个操作。');
        if (hasDagTargetDraft(id)) throw Error('请先处理分支中的原草稿。');
        const parent = latestSessions.current.find(s => s.id === branch.id)!;
        const request = createDagChildSend({ id, userId: session.userId, remoteHostId: session.remoteHostId,
          deviceLinkDeviceId: branch.deviceLinkDeviceId, parentSessionId: reused ? parent.parentSessionId : branch.id,
          forkedAtMessageId: reused ? parent.forkedAtMessageId : anchor }, text, current,
          reused ? {answerId:anchor, userMessageId:selected.userMessageId,
            stillIdleTip:async own => (await position()) === 'tip' && idle(own)} : undefined);
        const detach = mountPort(id, {submission:request});
        try {
          const result = await request.receipt;
          if (result === 'unknown') { attempt.status = 'unknown'; throw new UnconfirmedBranchSend(); }
          if (result === 'rejected') throw Error('请检查分支是否就绪、历史位置是否变化、是否已有草稿，再点「提问」。');
          attempt.status = 'accepted'; attempt.userMessageId = request.userMessageId;
        } finally { detach(); }
        if (!current()) return false as const;
        setRevision(v => v + 1);
        return accepted(attempt);
      } catch (e) {
        if (e instanceof UnconfirmedBranchSend) throw e;
        // A rejected in-place send created nothing. A later explicit click must
        // classify the anchor again (it may have become historical meanwhile).
        if (reused && attempt.status === 'created') attempts.current.delete(key);
        throw Error(`${reused ? '未在原分支续推' : '分支已创建，问题未发送'}。${e instanceof Error ? e.message : ''}`);
      }
    } catch (e) {
      if (e instanceof UnconfirmedBranchSend) {
        if (current()) setError(e.message);
        throw e;
      }
      if (live.current && writableScope.current === scope && isDataOwnerGenerationCurrent(owner))
        setError(`未发送：${e instanceof Error ? e.message : '无法打开历史分叉'}`);
      return false as const;
    } finally {
      release(operation);
    }
  }
  useEffect(() => {
    const changed = (event: Event) => {
      const ids = (event as CustomEvent<string[]>).detail;
      if (ids?.some(id => familyIds.has(id))) setRevision(v => v + 1);
    };
    window.addEventListener('dag-family-history-changed', changed);
    return () => window.removeEventListener('dag-family-history-changed', changed);
  }, [familyIds]);
  const historyActions = useDagHistoryActions({
    key: !readOnly && !session.remoteHostId && !session.deviceLinkDeviceId && loaded?.scope === scope ? loaded?.key : undefined,
    ready: !graph.loading && !graph.error, nodes: fullFamilyNodes, state: () => lastCanvas.current,
    writable: n => branchGuard(n).current() ? latestSessions.current.find(s => s.id === n.sessionId) : undefined,
    refresh: (sid, changed, reopenDraft) => {
      makerChatStore.reloadMessages(sid);
      for (const id of changed) if (id !== sid && makerChatStore.getSnapshot(id).messages.length) makerChatStore.reloadMessages(id);
      refresh();
      setActive(id => id && changed.includes(id) ? null : id);
      setPinned(p => p && changed.includes(p.id) ? null : p);
      if (reopenDraft) open(sid, '撤回的问题');
      setRevision(v => v + 1);
    },
  });
  const pane = active !== pinned?.id ? tabs.find(p => p.id === active) : undefined;
  const watchedIds = JSON.stringify(
    panes
      .map((p) => p.id)
      .filter((id) => id !== session.id)
      .sort(),
  );
  useEffect(() => {
    const ids = JSON.parse(watchedIds) as string[];
    const unsub = ids.map((id) => {
      let running = makerChatStore.getLightSnapshot(id).agentStatus.isRunning;
      return makerChatStore.subscribeLight(id, () => {
        const next = makerChatStore.getLightSnapshot(id).agentStatus.isRunning;
        if (running && !next) setRevision((value) => value + 1);
        running = next;
      });
    });
    return () => unsub.forEach((stop) => stop());
  }, [watchedIds]);
  const pin = (next: Pane) => {
    remember(next);
    if (!active || active === next.id) setActive(tabs.find(p => p.id !== next.id)?.id ?? null);
    setPinned(next);
    setShowPinned(true);
  };
  const consume = (target: Pane) => {
    if (!target.jump) return;
    setPanes(prev => prev.map(p => p.id === target.id && p.jump === target.jump ? { ...p, jump: null } : p));
    setPinned(p => p?.id === target.id && p.jump === target.jump ? { ...p, jump: null } : p);
  };
  const lastChat = useRef(session.id);
  const reopen = tabs.find(p => p.id === lastChat.current && p.id !== pinned?.id) ?? tabs.find(p => p.id !== pinned?.id);
  const closeChat = () => {
    if (active) lastChat.current = active;
    setActive(null);
    setShowPinned(false);
    setRevision((v) => v + 1);
  };
  return (
    <section className="relative flex h-full min-h-0 flex-col" aria-label="会话 DAG">
      {busy > 0 && (
        <span
          role="status"
          className="absolute left-3 top-3 z-10 rounded bg-background px-2 py-1 text-xs"
        >
          {busy > 1 ? `正在处理 ${busy} 个分支操作…` : '正在处理分支操作…'}
        </span>
      )}
      {(error || graph.error) && (
        <div role="alert" className="px-3 py-1">
          {error || graph.error}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {loaded && loaded.scope === scope ? (
            <SessionDagCanvas
              key={scope}
              nodes={nodes}
              fullFamilyNodes={fullFamilyNodes}
              historyReady={!graph.loading && !graph.error}
              storageKey={loaded.key}
              initialState={loaded.state}
              onStateChange={(key, state) => {
                if (!scope || writableScope.current !== scope || key !== loaded.key) return;
                lastCanvas.current = state;
                write(key, state, sideRef.current, retryLinks.current);
              }}
              onOpen={(n) =>
                open(
                  n.sessionId,
                  n.question.slice(0, 24) || '对话',
                  n.userMessageId ?? n.answerMessageId,
                )
              }
              onPin={(n) => pin(makePane(n.sessionId, n.question.slice(0, 24), n.userMessageId ?? n.answerMessageId))}
              onOpenChat={!pane && !pinned && reopen ? () => setActive(reopen.id) : undefined}
              onAction={prepare}
              onRetryFailed={retryFailed}
              historyActions={historyActions}
              readOnly={readOnly}
              onOpenPrepared={(id) => {
                if (familyIds.has(id) || awaitingList.current.has(id)) open(id, '推进');
                else setError('该分支不属于当前会话图或已不可用。');
              }}
            />
          ) : (
            <p role="status" className="p-4">
              {graph.loading ? '正在读取会话轮次…' : '正在读取画布…'}
            </p>
          )}
        </div>
        {Array.from(new Set([...(pinned ? [pinned.id] : []), ...(pane ? [pane.id] : []), ...ports.current.keys()])).map(id => {
          const fixed = pinned?.id === id;
          const visible = fixed || pane?.id === id;
          const target = (fixed ? pinned : pane?.id === id ? pane : tabs.find(t => t.id === id)) ?? makePane(id, '推进');
          const port = ports.current.get(id);
          return <aside key={id} aria-hidden={!visible || undefined}
            aria-label={fixed ? '固定分支对照' : visible ? '节点原生对话' : undefined}
            className={!visible ? 'hidden' : `${fixed ? (showPinned || !pane ? 'flex' : 'hidden') : (showPinned && pinned ? 'hidden' : 'flex')} absolute inset-0 z-10 min-h-0 min-w-0 flex-col border-l border-border bg-background md:static md:w-[clamp(17rem,29%,26rem)] xl:flex`}>
            {fixed && pinned ? (
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2 text-xs">
              <Pin size={14} />
              <span className="min-w-0 flex-1 truncate" title={pinned.label}>
                {pinned.label}
              </span>
              {(pane || reopen) && (
                <button
                  type="button"
                  className={`${iconButton} ${pane ? 'xl:hidden' : ''}`}
                  title="查看节点对话"
                  aria-label="查看节点对话"
                  onClick={() => {
                    if (!pane && reopen) setActive(reopen.id);
                    setShowPinned(false);
                  }}
                >
                  <PanelRightOpen size={15} />
                </button>
              )}
              <button
                type="button"
                className={iconButton}
                title="取消固定"
                aria-label="取消固定"
                onClick={() => {
                  if (!pane) setActive(pinned.id);
                  setPinned(null);
                  setShowPinned(false);
                }}
              >
                <PinOff size={15} />
              </button>
            </div>
            ) : visible && pane ? (
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
              {tabs.length === 1 ? (
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={pane.label}
                >
                  {pane.label}
                </span>
              ) : (
                <nav
                  aria-label="已打开的分支"
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                >
                  {tabs.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      className="max-w-40 shrink-0 truncate rounded px-2 py-1 text-xs text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
                      aria-pressed={p.id === active}
                      title={p.label}
                      onClick={() => p.id === pinned?.id ? setShowPinned(true) : open(p.id, p.label, p.jump?.messageClientId)}
                    >
                      {p.label}
                    </button>
                  ))}
                </nav>
              )}
              {!pinned && <button type="button" className={iconButton} title="固定此对话" aria-label="固定此对话" onClick={() => pin(pane)}><Pin size={15} /></button>}
              {pinned && (
                <button
                  type="button"
                  className={`${iconButton} xl:hidden`}
                  title="查看固定分支"
                  aria-label="查看固定分支"
                  onClick={() => setShowPinned(true)}
                >
                  <Pin size={15} />
                </button>
              )}
              <button
                type="button"
                className={iconButton}
                aria-label="收起聊天"
                title="收起聊天"
                onClick={closeChat}
              >
                <PanelRightClose size={16} />
              </button>
            </div>
            ) : null}
            <div className="min-h-0 flex-1">
              {renderChat(target, () => consume(target), port?.submission, port?.retry, !visible)}
            </div>
          </aside>;
        })}
      </div>
    </section>
  );
}
