/**
 * SplitGroup — `chat-main` 内部的同窗多任务递归分栏。
 *
 * 全局布局树仍只有一个 `chat-main`；本组件在其内部渲染二叉分屏树。每个 pane
 * 都可再次向四边拆分，因此支持左一右二、左二右二及更深的混合布局。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Columns2, Rows2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { getSessionDisplayTitle } from './lib/sessionDisplayTitle';
import { CCAgentSessionView } from './CCAgentSessionView';
import { mergeSessionSources } from './lib/mergeSessionSources';
import {
  SPLIT_GROUP_SESSION_MIME,
  hasSplitGroupSessionType,
  resolveSplitDropSide,
} from './splitGroupDnd';
import {
  getSplitPanes,
  MIN_SPLIT_CHILD_FRACTION,
  splitGroupStore,
  useSplitGroup,
  type DropSide,
  type SplitBranchNode,
  type SplitNode,
  type SplitPaneNode,
} from './splitGroupStore';

const GUTTER_PX = 6;
const KEYBOARD_RESIZE_STEP = 0.05;

function isSplitPaneChildActionTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(
    element?.closest('[data-split-pane-no-focus], button, a, [role="button"], [role="link"]'),
  );
}

interface SplitGroupProps {
  children: ReactNode;
  /** 仅 `/cc-agent/:sessionId` 传值；其它功能路由保持原样，不展示持久分屏。 */
  activeSessionId?: string;
}

export function SplitGroup({ children, activeSessionId }: SplitGroupProps) {
  const group = useSplitGroup();
  const navigate = useNavigate();
  const paneCount = getSplitPanes(group.root).length;

  const focusSession = useCallback(
    (sessionId: string) => {
      void resolveSessionRoute(sessionId).then((route) => navigate(route));
    },
    [navigate],
  );

  if (!activeSessionId) return <>{children}</>;

  if (!group.root || paneCount < 2) {
    return (
      <SplitDropTarget
        anchorSessionId={activeSessionId}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        dataAttribute="single"
        onSessionDropped={(sessionId, side) => {
          if (splitGroupStore.addSession(sessionId, activeSessionId, side)) {
            focusSession(sessionId);
          }
        }}
      >
        {children}
      </SplitDropTarget>
    );
  }

  return <SplitGroupActive activeSessionId={activeSessionId} root={group.root} />;
}

interface SplitGroupActiveProps {
  activeSessionId: string;
  root: SplitNode;
}

function SplitGroupActive({ activeSessionId, root }: SplitGroupActiveProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessions: localSessions } = useCCSessions({ includeArchived: 'all' });
  const remoteSessions = useRemoteProjectSessions();
  const sessions = useMemo(
    () => mergeSessionSources(localSessions, remoteSessions),
    [localSessions, remoteSessions],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const panes = useMemo(() => getSplitPanes(root), [root]);

  const previousActiveSessionIdRef = useRef(activeSessionId);
  const pendingFocusSessionIdRef = useRef<string | null>(null);
  const pendingPaneNavigationRef = useRef<{
    sourceSessionId: string;
    targetSessionId: string;
  } | null>(null);
  const routePane = panes.find((pane) => pane.sessionId === activeSessionId);
  const previousPane = panes.find((pane) => pane.sessionId === previousActiveSessionIdRef.current);
  const ownerPaneKey = routePane?.key ?? previousPane?.key ?? panes[0]?.key;

  const focusSession = useCallback(
    (sessionId: string) => {
      if (!sessionId || sessionId === activeSessionId) return;
      pendingFocusSessionIdRef.current = sessionId;
      const session = sessionsById.get(sessionId) ?? null;
      void resolveSessionRoute(sessionId, session)
        .then((route) => navigate(route))
        .catch(() => {
          pendingFocusSessionIdRef.current = null;
        });
    },
    [activeSessionId, navigate, sessionsById],
  );

  useEffect(() => {
    const pendingFocusSessionId = pendingFocusSessionIdRef.current;
    if (pendingFocusSessionId === activeSessionId) {
      pendingFocusSessionIdRef.current = null;
    }

    if (panes.some((pane) => pane.sessionId === activeSessionId)) {
      previousActiveSessionIdRef.current = activeSessionId;
      if (pendingPaneNavigationRef.current?.targetSessionId === activeSessionId) {
        pendingPaneNavigationRef.current = null;
      }
      return;
    }

    if (pendingFocusSessionId && pendingFocusSessionId !== activeSessionId) return;

    const pendingPaneNavigation = pendingPaneNavigationRef.current;
    pendingPaneNavigationRef.current = null;
    const pendingSource =
      pendingPaneNavigation?.targetSessionId === activeSessionId &&
      panes.some((pane) => pane.sessionId === pendingPaneNavigation.sourceSessionId)
        ? pendingPaneNavigation.sourceSessionId
        : null;
    const replaceTarget =
      pendingSource ??
      (panes.some((pane) => pane.sessionId === previousActiveSessionIdRef.current)
        ? previousActiveSessionIdRef.current
        : panes[0]?.sessionId);
    if (replaceTarget) {
      splitGroupStore.replaceSession(replaceTarget, activeSessionId);
      previousActiveSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId, panes]);

  const handlePaneSessionNavigate = useCallback(
    (sourceSessionId: string, targetSessionId: string) => {
      pendingPaneNavigationRef.current = { sourceSessionId, targetSessionId };
    },
    [],
  );

  const handleClosePane = useCallback(
    (pane: SplitPaneNode, isOwner: boolean) => {
      if (isOwner) {
        const paneIndex = panes.findIndex((candidate) => candidate.key === pane.key);
        const targetPane = panes[paneIndex + 1] ?? panes[paneIndex - 1];
        if (targetPane) focusSession(targetPane.sessionId);
      }
      splitGroupStore.removeSession(pane.sessionId);
    },
    [focusSession, panes],
  );

  return (
    <div
      data-split-group="active"
      data-split-root-direction={root.type === 'split' ? root.direction : undefined}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-content-area"
    >
      <SplitGroupToolbar root={root} />
      <div className="min-h-0 flex-1">
        <SplitNodeView
          node={root}
          activeSessionId={activeSessionId}
          ownerPaneKey={ownerPaneKey}
          sessionsById={sessionsById}
          focusSession={focusSession}
          onSessionNavigate={handlePaneSessionNavigate}
          onClosePane={handleClosePane}
          unnamedTitle={t('ccAgent.common.unnamedSession')}
          loadingTitle={t('splitGroup.loadingTask')}
        />
      </div>
    </div>
  );
}

interface SplitNodeViewProps {
  node: SplitNode;
  activeSessionId: string;
  ownerPaneKey?: string;
  sessionsById: Map<string, ReturnType<typeof useCCSessions>['sessions'][number]>;
  focusSession: (sessionId: string) => void;
  onSessionNavigate: (sourceSessionId: string, targetSessionId: string) => void;
  onClosePane: (pane: SplitPaneNode, isOwner: boolean) => void;
  unnamedTitle: string;
  loadingTitle: string;
}

function SplitNodeView({ node, ...childProps }: SplitNodeViewProps) {
  if (node.type === 'pane') return <SplitPaneView {...childProps} pane={node} />;
  return <SplitBranchView {...childProps} branch={node} />;
}

function SplitBranchView({
  branch,
  ...childProps
}: Omit<SplitNodeViewProps, 'node'> & {
  branch: SplitBranchNode;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [liveFraction, setLiveFraction] = useState<number | null>(null);
  const isRow = branch.direction === 'row';
  const fraction = liveFraction ?? branch.fraction;

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      document.body.classList.remove('resizing-pane');
    },
    [],
  );

  const handleGutterPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const totalAxisSize = (isRow ? rect.width : rect.height) - GUTTER_PX;
      if (totalAxisSize <= 0) return;

      resizeCleanupRef.current?.();
      const startPosition = isRow ? event.clientX : event.clientY;
      const baseFraction = branch.fraction;
      document.body.classList.add('resizing-pane');

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const position = isRow ? pointerEvent.clientX : pointerEvent.clientY;
        const raw = baseFraction + (position - startPosition) / totalAxisSize;
        const clamped = Math.min(
          1 - MIN_SPLIT_CHILD_FRACTION,
          Math.max(MIN_SPLIT_CHILD_FRACTION, raw),
        );
        setLiveFraction(clamped);
      };

      const finishResize = () => {
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', finishResize);
        document.removeEventListener('pointercancel', finishResize);
        document.body.classList.remove('resizing-pane');
        resizeCleanupRef.current = null;
        setLiveFraction((current) => {
          if (current !== null) splitGroupStore.setSplitFraction(branch.key, current);
          return null;
        });
      };

      resizeCleanupRef.current = finishResize;
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', finishResize);
      document.addEventListener('pointercancel', finishResize);
    },
    [branch.fraction, branch.key, isRow],
  );

  const handleGutterKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const decreaseKey = isRow ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = isRow ? 'ArrowRight' : 'ArrowDown';
      let nextFraction: number | null = null;
      if (event.key === decreaseKey) nextFraction = branch.fraction - KEYBOARD_RESIZE_STEP;
      else if (event.key === increaseKey) nextFraction = branch.fraction + KEYBOARD_RESIZE_STEP;
      else if (event.key === 'Home') nextFraction = 0;
      else if (event.key === 'End') nextFraction = 1;
      if (nextFraction === null) return;
      event.preventDefault();
      splitGroupStore.setSplitFraction(branch.key, nextFraction);
    },
    [branch.fraction, branch.key, isRow],
  );

  const firstStyle: CSSProperties = { flexBasis: 0, flexGrow: fraction, flexShrink: 1 };
  const secondStyle: CSSProperties = {
    flexBasis: 0,
    flexGrow: 1 - fraction,
    flexShrink: 1,
  };

  return (
    <div
      ref={containerRef}
      data-split-branch={branch.key}
      data-split-direction={branch.direction}
      className={cn('flex h-full min-h-0 w-full min-w-0', isRow ? 'flex-row' : 'flex-col')}
    >
      <div className="min-h-0 min-w-0 overflow-hidden" style={firstStyle}>
        <SplitNodeView node={branch.first} {...childProps} />
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        aria-label={t('splitGroup.resizeAria')}
        aria-valuemin={Math.round(MIN_SPLIT_CHILD_FRACTION * 100)}
        aria-valuemax={Math.round((1 - MIN_SPLIT_CHILD_FRACTION) * 100)}
        aria-valuenow={Math.round(fraction * 100)}
        onPointerDown={handleGutterPointerDown}
        onKeyDown={handleGutterKeyDown}
        className={cn(
          'shrink-0 bg-border/50 transition-colors hover:bg-foreground/20',
          'focus-visible:bg-foreground/30 focus-visible:outline-none',
          isRow ? 'cursor-col-resize' : 'cursor-row-resize',
        )}
        style={isRow ? { width: GUTTER_PX } : { height: GUTTER_PX }}
      />
      <div className="min-h-0 min-w-0 overflow-hidden" style={secondStyle}>
        <SplitNodeView node={branch.second} {...childProps} />
      </div>
    </div>
  );
}

function SplitPaneView({
  pane,
  activeSessionId,
  ownerPaneKey,
  sessionsById,
  focusSession,
  onSessionNavigate,
  onClosePane,
  unnamedTitle,
  loadingTitle,
}: Omit<SplitNodeViewProps, 'node'> & { pane: SplitPaneNode }) {
  const { t } = useTranslation();
  const isOwner = pane.key === ownerPaneKey;
  const viewSessionId = isOwner ? activeSessionId : pane.sessionId;
  const session = sessionsById.get(viewSessionId) ?? null;
  const title = session ? getSessionDisplayTitle(session, unnamedTitle) : loadingTitle;

  return (
    <SplitDropTarget
      anchorSessionId={pane.sessionId}
      className="relative h-full min-h-0 min-w-0 overflow-hidden"
      dataAttribute="pane"
      onSessionDropped={(sessionId, side) => {
        if (splitGroupStore.addSession(sessionId, pane.sessionId, side)) {
          focusSession(sessionId);
        }
      }}
    >
      <div
        data-split-pane-key={pane.key}
        data-split-pane-session-id={viewSessionId}
        data-split-pane-owner={isOwner ? 'true' : 'false'}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden"
        onPointerDownCapture={(event) => {
          if (isOwner || event.button !== 0 || isSplitPaneChildActionTarget(event.target)) {
            return;
          }
          focusSession(viewSessionId);
        }}
        onFocusCapture={(event) => {
          if (
            isOwner ||
            event.currentTarget.contains(event.relatedTarget as Node | null) ||
            isSplitPaneChildActionTarget(event.target)
          ) {
            return;
          }
          focusSession(viewSessionId);
        }}
      >
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 px-2">
          <button
            type="button"
            onClick={() => focusSession(viewSessionId)}
            className={cn(
              'min-w-0 flex-1 truncate rounded-full px-2 py-1 text-left text-xs transition-colors',
              isOwner
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            title={title}
          >
            {title}
          </button>
          <button
            type="button"
            data-split-pane-no-focus
            aria-label={t('splitGroup.closeAria', { title })}
            title={t('splitGroup.closeAria', { title })}
            onClick={() => onClosePane(pane, isOwner)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <CCAgentSessionView
            sessionIdProp={viewSessionId}
            routeOwner={isOwner}
            compactToolbar
            navigationMode={isOwner ? 'route-owner' : 'split-pane'}
            onSessionNavigate={(targetSessionId) =>
              onSessionNavigate(viewSessionId, targetSessionId)
            }
            sidebarTargetSessionId={viewSessionId}
            viewVisible
            chatRealtime
          />
        </div>
      </div>
    </SplitDropTarget>
  );
}

function SplitGroupToolbar({ root }: { root: SplitNode }) {
  const { t } = useTranslation();
  const direction = root.type === 'split' ? root.direction : 'row';
  return (
    <div
      data-split-group-toolbar
      className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-border/40 px-2"
    >
      <button
        type="button"
        aria-label={t('splitGroup.toggleDirection')}
        title={t('splitGroup.toggleDirection')}
        onClick={() => splitGroupStore.toggleRootDirection()}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        {direction === 'row' ? <Rows2 size={13} /> : <Columns2 size={13} />}
      </button>
      <button
        type="button"
        aria-label={t('splitGroup.closeAll')}
        title={t('splitGroup.closeAll')}
        onClick={() => splitGroupStore.clear()}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  );
}

interface SplitDropTargetProps {
  anchorSessionId: string;
  children: ReactNode;
  className?: string;
  dataAttribute: 'single' | 'pane';
  onSessionDropped: (sessionId: string, side: DropSide) => void;
}

function SplitDropTarget({
  anchorSessionId,
  children,
  className,
  dataAttribute,
  onSessionDropped,
}: SplitDropTargetProps) {
  const { t } = useTranslation();
  const [dropSide, setDropSide] = useState<DropSide | null>(null);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasSplitGroupSessionType(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const nextSide = resolveSplitDropSide(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    setDropSide((currentSide) => (currentSide === nextSide ? currentSide : nextSide));
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropSide(null);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasSplitGroupSessionType(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();
      const sessionId = event.dataTransfer.getData(SPLIT_GROUP_SESSION_MIME).trim();
      const side =
        dropSide ??
        resolveSplitDropSide(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
      setDropSide(null);
      if (!sessionId || !side || sessionId === anchorSessionId) return;
      onSessionDropped(sessionId, side);
    },
    [anchorSessionId, dropSide, onSessionDropped],
  );

  return (
    <div
      data-split-drop-target={dataAttribute}
      className={className}
      onDragOverCapture={handleDragOver}
      onDragLeaveCapture={handleDragLeave}
      onDropCapture={handleDrop}
    >
      {children}
      {dropSide && <DropHighlight side={dropSide} label={t('splitGroup.dropHint')} />}
    </div>
  );
}

function DropHighlight({ side, label }: { side: DropSide; label: string }) {
  const positionClass =
    side === 'left'
      ? 'left-0 top-0 h-full w-1/2'
      : side === 'right'
        ? 'right-0 top-0 h-full w-1/2'
        : side === 'top'
          ? 'left-0 top-0 h-1/2 w-full'
          : 'bottom-0 left-0 h-1/2 w-full';
  return (
    <div
      data-split-drop-side={side}
      className={cn(
        'pointer-events-none absolute z-40 flex items-center justify-center',
        'border-2 border-foreground/30 bg-foreground/5 backdrop-blur-[1px]',
        positionClass,
      )}
    >
      <span className="rounded-lg border border-border bg-content-area/95 px-2 py-1 text-xs text-foreground">
        {label}
      </span>
    </div>
  );
}
