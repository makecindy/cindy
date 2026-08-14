/**
 * SplitGroup — `chat-main` 内部的同窗多任务递归分栏。
 *
 * 全局布局树仍只有一个 `chat-main`；本组件在其内部渲染二叉分屏树。每个 pane
 * 都可再次向四边拆分，因此支持左一右二、左二右二及更深的混合布局。
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import {
  useRemoteBootstrapFailedDeviceIds,
  useRemoteBootstrapLoadingDeviceIds,
  useRemoteProjectSessions,
} from '@/features/device-link/remoteProjectsStore';
import { ApiError } from '@/lib/httpClient';
import { getSessionFor } from '@/lib/makerTransport';
import { getSessionRouteOwnerId, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { getSessionDisplayTitle } from './lib/sessionDisplayTitle';
import { CCAgentSessionView } from './CCAgentSessionView';
import { mergeSessionSources } from './lib/mergeSessionSources';
import {
  SPLIT_GROUP_SESSION_MIME,
  hasSplitGroupSessionType,
  isSplitGroupComposerDropTarget,
  resolveSplitDropSide,
} from './splitGroupDnd';
import {
  getSplitPanes,
  MAX_SPLIT_PANES,
  MIN_SPLIT_CHILD_FRACTION,
  splitGroupStore,
  useSplitGroup,
  type DropSide,
  type SplitGroupAddBlockReason,
  type SplitBranchNode,
  type SplitNode,
  type SplitPaneNode,
} from './splitGroupStore';

const GUTTER_PX = 6;
const KEYBOARD_RESIZE_STEP = 0.05;
const MIN_SPLIT_PANE_WIDTH_PX = 280;
const MIN_SPLIT_PANE_HEIGHT_PX = 220;
const DEFAULT_SPLIT_VIEWPORT_WIDTH_PX = 800;
const DEFAULT_SPLIT_VIEWPORT_HEIGHT_PX = 600;

function isSplitPaneNoFocusTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest('[data-split-pane-no-focus], [data-split-pane-route-action]'));
}

function showSplitAddBlocked(
  t: ReturnType<typeof useTranslation>['t'],
  reason: SplitGroupAddBlockReason | null,
): void {
  if (reason === 'limit-reached') {
    toast.warning(t('splitGroup.limitReached', { count: MAX_SPLIT_PANES }));
    return;
  }
  if (reason === 'duplicate') {
    toast.warning(t('splitGroup.alreadyOpen'));
    return;
  }
  toast.warning(t('splitGroup.addUnavailable'));
}

interface SplitGroupProps {
  children: ReactNode;
  /** 仅 `/cc-agent/:sessionId` 传值；其它功能路由保持原样，不展示持久分屏。 */
  activeSessionId?: string;
}

export function SplitGroup({ children, activeSessionId }: SplitGroupProps) {
  const { t } = useTranslation();
  const group = useSplitGroup();
  const navigate = useNavigate();
  const paneCount = getSplitPanes(group.root).length;
  const staleRecoveryActiveSessionIdRef = useRef(activeSessionId);
  const staleRecoverySequenceRef = useRef(0);
  // SplitGroupActive 卸载于 `/cc-agent/new`，但外层 layout 仍然常驻。保留最近一次
  // 真正位于分屏树中的路由 owner，避免新任务创建后重新挂载时退回替换 panes[0]。
  const lastActiveSessionIdRef = useRef(activeSessionId);

  useLayoutEffect(() => {
    if (
      activeSessionId &&
      getSplitPanes(group.root).some((pane) => pane.sessionId === activeSessionId)
    ) {
      lastActiveSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId, group.root]);

  useLayoutEffect(() => {
    if (staleRecoveryActiveSessionIdRef.current !== activeSessionId) {
      staleRecoveryActiveSessionIdRef.current = activeSessionId;
      staleRecoverySequenceRef.current += 1;
    }
  }, [activeSessionId]);

  useEffect(
    () => () => {
      staleRecoverySequenceRef.current += 1;
    },
    [],
  );

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
          } else {
            showSplitAddBlocked(t, splitGroupStore.getAddBlockReason(sessionId, activeSessionId));
          }
        }}
      >
        {children}
      </SplitDropTarget>
    );
  }

  return (
    <SplitGroupActive
      activeSessionId={activeSessionId}
      root={group.root}
      previousActiveSessionId={lastActiveSessionIdRef.current}
      staleRecoverySequenceRef={staleRecoverySequenceRef}
    />
  );
}

interface SplitGroupActiveProps {
  activeSessionId: string;
  previousActiveSessionId?: string;
  root: SplitNode;
  staleRecoverySequenceRef: { current: number };
}

function SplitGroupActive({
  activeSessionId,
  previousActiveSessionId,
  root,
  staleRecoverySequenceRef,
}: SplitGroupActiveProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    sessions: localSessions,
    isLoading: localSessionsLoading,
    error: localSessionsError,
  } = useCCSessions({ includeArchived: 'all' });
  const remoteSessions = useRemoteProjectSessions();
  const remoteBootstrapLoadingDeviceIds = useRemoteBootstrapLoadingDeviceIds();
  const remoteBootstrapFailedDeviceIds = useRemoteBootstrapFailedDeviceIds();
  const sessions = useMemo(
    () => mergeSessionSources(localSessions, remoteSessions),
    [localSessions, remoteSessions],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const panes = useMemo(() => getSplitPanes(root), [root]);
  const sessionsCatalogReady =
    !localSessionsLoading &&
    !localSessionsError &&
    remoteBootstrapLoadingDeviceIds.size === 0 &&
    remoteBootstrapFailedDeviceIds.size === 0;

  const previousActiveSessionIdRef = useRef(previousActiveSessionId ?? activeSessionId);
  const observedActiveSessionIdRef = useRef(activeSessionId);
  const pendingFocusSessionIdRef = useRef<string | null>(null);
  const focusRequestSequenceRef = useRef(0);
  const resolvedRouteOwnersRef = useRef(new Map<number, string>());
  const confirmedStaleRouteOwnerRef = useRef<string | null>(null);
  const pendingOwnerCloseRef = useRef<{
    sourceSessionId: string;
    targetSessionId: string;
    requestSequence: number;
    routeOwnerSessionId?: string;
  } | null>(null);
  const pendingPaneNavigationRef = useRef<{
    sourceSessionId: string;
    targetSessionId: string;
    routeOwnerSessionId: string;
  } | null>(null);
  const routePane = panes.find((pane) => pane.sessionId === activeSessionId);
  const previousPane = panes.find((pane) => pane.sessionId === previousActiveSessionIdRef.current);
  const ownerPaneKey = routePane?.key ?? previousPane?.key ?? panes[0]?.key;

  useEffect(() => {
    if (!sessionsCatalogReady) return;
    const missingSessionIds = panes
      .map((pane) => pane.sessionId)
      .filter((sessionId) => !sessionsById.has(sessionId));
    if (missingSessionIds.length === 0) return;
    let cancelled = false;

    // The merged catalog is eventually consistent while local refreshes and
    // device-link mirrors rebuild. Only prune after the session's owning side
    // confirms the pane is no longer active or is absent; getSessionFor
    // preserves remote routing.
    void Promise.all(
      missingSessionIds.map(async (sessionId) => {
        try {
          const session = await getSessionFor(sessionId);
          return session.status === 'archived' || session.status === 'deleted' ? sessionId : null;
        } catch (error) {
          const errorCode = error instanceof ApiError ? error.code : extractIpcError(error)?.code;
          return errorCode === 'NOT_FOUND' ? sessionId : null;
        }
      }),
    ).then((staleSessionIds) => {
      if (cancelled) return;
      const confirmedStaleSessionIds = staleSessionIds.filter((sessionId): sessionId is string =>
        Boolean(sessionId && !sessionsById.has(sessionId)),
      );
      if (confirmedStaleSessionIds.includes(activeSessionId)) {
        confirmedStaleRouteOwnerRef.current = activeSessionId;
        const survivor = panes.find((pane) => !confirmedStaleSessionIds.includes(pane.sessionId));
        if (survivor) {
          const recoverySequence = staleRecoverySequenceRef.current;
          void resolveSessionRoute(survivor.sessionId, sessionsById.get(survivor.sessionId) ?? null)
            .then((route) => {
              if (staleRecoverySequenceRef.current === recoverySequence) {
                navigate(route, { replace: true });
              }
            })
            .catch(() => {
              if (staleRecoverySequenceRef.current === recoverySequence) {
                navigate('/cc-agent', { replace: true });
              }
            });
        } else {
          navigate('/cc-agent', { replace: true });
        }
      }
      for (const sessionId of confirmedStaleSessionIds) {
        splitGroupStore.removeSession(sessionId);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, navigate, panes, sessionsById, sessionsCatalogReady]);

  useEffect(
    () => () => {
      focusRequestSequenceRef.current += 1;
      pendingFocusSessionIdRef.current = null;
      pendingOwnerCloseRef.current = null;
      resolvedRouteOwnersRef.current.clear();
      confirmedStaleRouteOwnerRef.current = null;
    },
    [],
  );

  const focusSession = useCallback(
    (sessionId: string) => {
      if (!sessionId || sessionId === activeSessionId) {
        return null;
      }
      if (pendingFocusSessionIdRef.current === sessionId) {
        return focusRequestSequenceRef.current;
      }
      if (pendingOwnerCloseRef.current?.targetSessionId !== sessionId) {
        pendingOwnerCloseRef.current = null;
      }
      const requestSequence = ++focusRequestSequenceRef.current;
      pendingFocusSessionIdRef.current = sessionId;
      const session = sessionsById.get(sessionId) ?? null;
      void resolveSessionRoute(sessionId, session)
        .then((route) => {
          if (focusRequestSequenceRef.current !== requestSequence) return;
          const routeOwnerSessionId = getSessionRouteOwnerId(route) ?? sessionId;
          resolvedRouteOwnersRef.current.set(requestSequence, routeOwnerSessionId);
          if (pendingOwnerCloseRef.current?.requestSequence === requestSequence) {
            pendingOwnerCloseRef.current.routeOwnerSessionId = routeOwnerSessionId;
          }
          navigate(route);
        })
        .catch(() => {
          if (focusRequestSequenceRef.current === requestSequence) {
            pendingFocusSessionIdRef.current = null;
            if (pendingOwnerCloseRef.current?.requestSequence === requestSequence) {
              pendingOwnerCloseRef.current = null;
            }
          }
        });
      return requestSequence;
    },
    [activeSessionId, navigate, sessionsById],
  );

  useLayoutEffect(() => {
    if (
      confirmedStaleRouteOwnerRef.current &&
      confirmedStaleRouteOwnerRef.current !== activeSessionId
    ) {
      confirmedStaleRouteOwnerRef.current = null;
    }
    const pendingFocusSessionId = pendingFocusSessionIdRef.current;
    const activeSessionChanged = observedActiveSessionIdRef.current !== activeSessionId;
    observedActiveSessionIdRef.current = activeSessionId;
    const pendingOwnerClose = pendingOwnerCloseRef.current;
    const matchingResolvedSequences = [...resolvedRouteOwnersRef.current.entries()]
      .filter(([, routeOwnerSessionId]) => routeOwnerSessionId === activeSessionId)
      .map(([requestSequence]) => requestSequence);
    const latestMatchingResolvedSequence =
      matchingResolvedSequences.length > 0 ? Math.max(...matchingResolvedSequences) : null;
    const pendingFocusReachedRouteOwner =
      pendingOwnerClose?.requestSequence === focusRequestSequenceRef.current &&
      pendingOwnerClose.routeOwnerSessionId === activeSessionId;
    const currentFocusReachedRouteOwner =
      latestMatchingResolvedSequence === focusRequestSequenceRef.current;
    if (
      pendingFocusSessionId === activeSessionId ||
      pendingFocusReachedRouteOwner ||
      currentFocusReachedRouteOwner
    ) {
      pendingFocusSessionIdRef.current = null;
    } else if (pendingFocusSessionId && activeSessionChanged) {
      const isOlderFocusCommit =
        latestMatchingResolvedSequence !== null &&
        latestMatchingResolvedSequence < focusRequestSequenceRef.current;
      if (!isOlderFocusCommit) {
        pendingFocusSessionIdRef.current = null;
        focusRequestSequenceRef.current += 1;
      }
    }
    for (const requestSequence of matchingResolvedSequences) {
      resolvedRouteOwnersRef.current.delete(requestSequence);
    }

    if (
      pendingOwnerClose &&
      (!panes.some((pane) => pane.sessionId === pendingOwnerClose.targetSessionId) ||
        pendingOwnerClose.requestSequence !== focusRequestSequenceRef.current)
    ) {
      pendingOwnerCloseRef.current = null;
      if (pendingFocusSessionIdRef.current === pendingOwnerClose.targetSessionId) {
        pendingFocusSessionIdRef.current = null;
        focusRequestSequenceRef.current += 1;
      }
    } else if (pendingOwnerClose?.routeOwnerSessionId === activeSessionId) {
      // Keep the route owner in the tree until its navigation request has committed.
      // Removing it earlier lets route reconciliation restore the pane just closed.
      pendingOwnerCloseRef.current = null;
      if (panes.some((pane) => pane.sessionId === pendingOwnerClose.sourceSessionId)) {
        splitGroupStore.removeSession(pendingOwnerClose.sourceSessionId);
      }
      return;
    }

    if (panes.some((pane) => pane.sessionId === activeSessionId)) {
      previousActiveSessionIdRef.current = activeSessionId;
      if (pendingPaneNavigationRef.current?.routeOwnerSessionId === activeSessionId) {
        pendingPaneNavigationRef.current = null;
      }
      return;
    }

    if (confirmedStaleRouteOwnerRef.current === activeSessionId) return;

    const pendingPaneNavigation = pendingPaneNavigationRef.current;
    pendingPaneNavigationRef.current = null;
    const pendingNavigationMatchesRoute =
      pendingPaneNavigation?.routeOwnerSessionId === activeSessionId;
    const pendingNavigationSourceExists = Boolean(
      pendingPaneNavigation &&
      panes.some((pane) => pane.sessionId === pendingPaneNavigation.sourceSessionId),
    );
    if (pendingNavigationMatchesRoute && !pendingNavigationSourceExists) {
      // The child action resolved after its source pane was removed. Do not let
      // the stale intent fall through and replace the current owner pane.
      return;
    }
    const pendingSource =
      pendingNavigationMatchesRoute && pendingNavigationSourceExists
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
    (sourceSessionId: string, targetSessionId: string, routeOwnerSessionId?: string) => {
      // Child route actions (session links, handoff cards, encrypted recovery) are
      // allowed to focus their pane on pointer/keyboard entry, but once the child
      // announces its own target, suppress that pending source-pane navigation so
      // it cannot race and overwrite the target route.
      pendingFocusSessionIdRef.current = null;
      focusRequestSequenceRef.current += 1;
      pendingOwnerCloseRef.current = null;
      pendingPaneNavigationRef.current = {
        sourceSessionId,
        targetSessionId,
        routeOwnerSessionId: routeOwnerSessionId ?? targetSessionId,
      };
    },
    [],
  );

  const handleClosePane = useCallback(
    (pane: SplitPaneNode, isOwner: boolean) => {
      if (pendingOwnerCloseRef.current?.targetSessionId === pane.sessionId) {
        pendingOwnerCloseRef.current = null;
      }
      if (pendingFocusSessionIdRef.current === pane.sessionId) {
        pendingFocusSessionIdRef.current = null;
        focusRequestSequenceRef.current += 1;
      }
      if (isOwner) {
        const paneIndex = panes.findIndex((candidate) => candidate.key === pane.key);
        const targetPane = panes[paneIndex + 1] ?? panes[paneIndex - 1];
        if (targetPane) {
          const requestSequence = focusSession(targetPane.sessionId);
          if (requestSequence === null) return;
          pendingOwnerCloseRef.current = {
            sourceSessionId: pane.sessionId,
            targetSessionId: targetPane.sessionId,
            requestSequence,
            routeOwnerSessionId: resolvedRouteOwnersRef.current.get(requestSequence),
          };
          return;
        }
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
      <div className="min-h-0 flex-1 overflow-hidden">
        <SplitGroupCanvas
          root={root}
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

interface SplitPaneSharedProps {
  activeSessionId: string;
  ownerPaneKey?: string;
  sessionsById: Map<string, ReturnType<typeof useCCSessions>['sessions'][number]>;
  focusSession: (sessionId: string) => void;
  onSessionNavigate: (
    sourceSessionId: string,
    targetSessionId: string,
    routeOwnerSessionId?: string,
  ) => void;
  onClosePane: (pane: SplitPaneNode, isOwner: boolean) => void;
  unnamedTitle: string;
  loadingTitle: string;
}

interface SplitLayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SplitPaneLayout {
  pane: SplitPaneNode;
  rect: SplitLayoutRect;
}

interface SplitBranchLayout {
  branch: SplitBranchNode;
  rect: SplitLayoutRect;
  firstAxisSize: number;
  displayedFraction: number;
}

interface SplitRequiredSize {
  width: number;
  height: number;
}

function getSplitRequiredSize(node: SplitNode): SplitRequiredSize {
  if (node.type === 'pane') {
    return { width: MIN_SPLIT_PANE_WIDTH_PX, height: MIN_SPLIT_PANE_HEIGHT_PX };
  }
  const first = getSplitRequiredSize(node.first);
  const second = getSplitRequiredSize(node.second);
  return node.direction === 'row'
    ? {
        width: first.width + GUTTER_PX + second.width,
        height: Math.max(first.height, second.height),
      }
    : {
        width: Math.max(first.width, second.width),
        height: first.height + GUTTER_PX + second.height,
      };
}

function resolveSplitLayout(
  node: SplitNode,
  rect: SplitLayoutRect,
  liveResize: { splitKey: string; fraction: number } | null,
  paneLayouts: SplitPaneLayout[],
  branchLayouts: SplitBranchLayout[],
): void {
  if (node.type === 'pane') {
    paneLayouts.push({ pane: node, rect });
    return;
  }

  const isRow = node.direction === 'row';
  const axisSize = Math.max(0, (isRow ? rect.width : rect.height) - GUTTER_PX);
  const firstRequired = getSplitRequiredSize(node.first);
  const secondRequired = getSplitRequiredSize(node.second);
  const firstMinimum = isRow ? firstRequired.width : firstRequired.height;
  const secondMinimum = isRow ? secondRequired.width : secondRequired.height;
  const requestedFraction = liveResize?.splitKey === node.key ? liveResize.fraction : node.fraction;
  const requestedFirstSize = axisSize * requestedFraction;
  const maximumFirstSize = Math.max(firstMinimum, axisSize - secondMinimum);
  const firstAxisSize = Math.min(maximumFirstSize, Math.max(firstMinimum, requestedFirstSize));
  const normalizedFirstAxisSize = Math.max(0, Math.min(axisSize, firstAxisSize));
  const displayedFraction = axisSize > 0 ? normalizedFirstAxisSize / axisSize : requestedFraction;
  branchLayouts.push({
    branch: node,
    rect,
    firstAxisSize: normalizedFirstAxisSize,
    displayedFraction,
  });

  const firstRect: SplitLayoutRect = isRow
    ? { ...rect, width: normalizedFirstAxisSize }
    : { ...rect, height: normalizedFirstAxisSize };
  const secondRect: SplitLayoutRect = isRow
    ? {
        ...rect,
        left: rect.left + normalizedFirstAxisSize + GUTTER_PX,
        width: Math.max(0, axisSize - normalizedFirstAxisSize),
      }
    : {
        ...rect,
        top: rect.top + normalizedFirstAxisSize + GUTTER_PX,
        height: Math.max(0, axisSize - normalizedFirstAxisSize),
      };
  resolveSplitLayout(node.first, firstRect, liveResize, paneLayouts, branchLayouts);
  resolveSplitLayout(node.second, secondRect, liveResize, paneLayouts, branchLayouts);
}

function SplitGroupCanvas({ root, ...paneProps }: SplitPaneSharedProps & { root: SplitNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({
    width: DEFAULT_SPLIT_VIEWPORT_WIDTH_PX,
    height: DEFAULT_SPLIT_VIEWPORT_HEIGHT_PX,
  });
  const [liveResize, setLiveResize] = useState<{
    splitKey: string;
    fraction: number;
  } | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => {
      const rect = viewport.getBoundingClientRect();
      const width = Math.max(0, viewport.clientWidth || rect.width);
      const height = Math.max(0, viewport.clientHeight || rect.height);
      if (width === 0 || height === 0) return;
      setViewportSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const requiredSize = useMemo(() => getSplitRequiredSize(root), [root]);
  const canvasSize = {
    width: Math.max(viewportSize.width, requiredSize.width),
    height: Math.max(viewportSize.height, requiredSize.height),
  };
  const { paneLayouts, branchLayouts } = useMemo(() => {
    const nextPaneLayouts: SplitPaneLayout[] = [];
    const nextBranchLayouts: SplitBranchLayout[] = [];
    resolveSplitLayout(
      root,
      { left: 0, top: 0, width: canvasSize.width, height: canvasSize.height },
      liveResize,
      nextPaneLayouts,
      nextBranchLayouts,
    );
    return { paneLayouts: nextPaneLayouts, branchLayouts: nextBranchLayouts };
  }, [canvasSize.height, canvasSize.width, liveResize, root]);

  useEffect(() => {
    if (liveResize && !branchLayouts.some((layout) => layout.branch.key === liveResize.splitKey)) {
      setLiveResize(null);
    }
  }, [branchLayouts, liveResize]);

  return (
    <div ref={viewportRef} className="h-full min-h-0 w-full min-w-0 overflow-auto">
      <div
        data-split-canvas
        className="relative"
        style={{ width: canvasSize.width, height: canvasSize.height }}
      >
        {paneLayouts.map(({ pane, rect }) => (
          <div key={pane.key} className="absolute overflow-hidden" style={rect}>
            <SplitPaneView {...paneProps} pane={pane} />
          </div>
        ))}
        {branchLayouts.map((layout) => (
          <SplitGutter
            key={layout.branch.key}
            {...layout}
            onLiveFraction={(fraction) => setLiveResize({ splitKey: layout.branch.key, fraction })}
            onCommit={(fraction) => {
              setLiveResize(null);
              splitGroupStore.setSplitFraction(layout.branch.key, fraction);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function SplitGutter({
  branch,
  rect,
  firstAxisSize,
  displayedFraction,
  onLiveFraction,
  onCommit,
}: SplitBranchLayout & {
  onLiveFraction: (fraction: number) => void;
  onCommit: (fraction: number) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const liveFractionRef = useRef<number | null>(null);
  const isRow = branch.direction === 'row';

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
      const baseFraction = displayedFraction;
      document.body.classList.add('resizing-pane');

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const position = isRow ? pointerEvent.clientX : pointerEvent.clientY;
        const raw = baseFraction + (position - startPosition) / totalAxisSize;
        const clamped = Math.min(
          1 - MIN_SPLIT_CHILD_FRACTION,
          Math.max(MIN_SPLIT_CHILD_FRACTION, raw),
        );
        liveFractionRef.current = clamped;
        onLiveFraction(clamped);
      };

      const finishResize = () => {
        if (resizeCleanupRef.current !== finishResize) return;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', finishResize);
        document.removeEventListener('pointercancel', finishResize);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('blur', finishResize);
        document.body.classList.remove('resizing-pane');
        resizeCleanupRef.current = null;
        const finalFraction = liveFractionRef.current;
        liveFractionRef.current = null;
        if (finalFraction !== null) onCommit(finalFraction);
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') finishResize();
      };

      resizeCleanupRef.current = finishResize;
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', finishResize);
      document.addEventListener('pointercancel', finishResize);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('blur', finishResize);
    },
    [displayedFraction, isRow, onCommit, onLiveFraction],
  );

  const handleGutterKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const decreaseKey = isRow ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = isRow ? 'ArrowRight' : 'ArrowDown';
      let nextFraction: number | null = null;
      if (event.key === decreaseKey) nextFraction = displayedFraction - KEYBOARD_RESIZE_STEP;
      else if (event.key === increaseKey) nextFraction = displayedFraction + KEYBOARD_RESIZE_STEP;
      else if (event.key === 'Home') nextFraction = 0;
      else if (event.key === 'End') nextFraction = 1;
      if (nextFraction === null) return;
      event.preventDefault();
      onCommit(nextFraction);
    },
    [displayedFraction, isRow, onCommit],
  );

  return (
    <div
      ref={containerRef}
      data-split-branch={branch.key}
      data-split-direction={branch.direction}
      className="pointer-events-none absolute"
      style={rect}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        aria-label={t('splitGroup.resizeAria')}
        aria-valuemin={Math.round(MIN_SPLIT_CHILD_FRACTION * 100)}
        aria-valuemax={Math.round((1 - MIN_SPLIT_CHILD_FRACTION) * 100)}
        aria-valuenow={Math.round(displayedFraction * 100)}
        onPointerDown={handleGutterPointerDown}
        onKeyDown={handleGutterKeyDown}
        className={cn(
          'pointer-events-auto absolute shrink-0 bg-border/50 transition-colors hover:bg-foreground/20',
          'focus-visible:bg-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
          isRow ? 'cursor-col-resize' : 'cursor-row-resize',
        )}
        style={
          isRow
            ? { left: firstAxisSize, top: 0, width: GUTTER_PX, height: rect.height }
            : { left: 0, top: firstAxisSize, width: rect.width, height: GUTTER_PX }
        }
      />
    </div>
  );
}

const SplitPaneView = memo(function SplitPaneView({
  pane,
  ownerPaneKey,
  sessionsById,
  focusSession,
  onSessionNavigate,
  onClosePane,
  unnamedTitle,
  loadingTitle,
}: SplitPaneSharedProps & { pane: SplitPaneNode }) {
  const { t } = useTranslation();
  const isOwner = pane.key === ownerPaneKey;
  const viewSessionId = pane.sessionId;
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
        } else {
          showSplitAddBlocked(t, splitGroupStore.getAddBlockReason(sessionId, pane.sessionId));
        }
      }}
    >
      <div
        data-split-pane-key={pane.key}
        data-split-pane-session-id={viewSessionId}
        data-split-pane-owner={isOwner ? 'true' : 'false'}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden"
        onPointerDownCapture={(event) => {
          if (
            isOwner ||
            (event.button !== 0 && event.button !== 2) ||
            isSplitPaneNoFocusTarget(event.target)
          ) {
            return;
          }
          focusSession(viewSessionId);
        }}
        onFocusCapture={(event) => {
          const focusMovedWithinPane = event.currentTarget.contains(
            event.relatedTarget as Node | null,
          );
          if (
            isOwner ||
            isSplitPaneNoFocusTarget(event.target) ||
            (focusMovedWithinPane && !isSplitPaneNoFocusTarget(event.relatedTarget))
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
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
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
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
            onSessionNavigate={(targetSessionId, routeOwnerSessionId) =>
              onSessionNavigate(viewSessionId, targetSessionId, routeOwnerSessionId)
            }
            sidebarTargetSessionId={viewSessionId}
            disableAutofocus={!isOwner}
            viewVisible
            chatRealtime
          />
        </div>
      </div>
    </SplitDropTarget>
  );
});

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
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        {direction === 'row' ? <Rows2 size={13} /> : <Columns2 size={13} />}
      </button>
      <button
        type="button"
        aria-label={t('splitGroup.closeAll')}
        title={t('splitGroup.closeAll')}
        onClick={() => splitGroupStore.clear()}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
    if (isSplitGroupComposerDropTarget(event.target)) {
      setDropSide(null);
      return;
    }
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
      if (isSplitGroupComposerDropTarget(event.target)) {
        setDropSide(null);
        return;
      }
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
        'border border-foreground/30 bg-foreground/5',
        positionClass,
      )}
    >
      <span className="rounded-full border border-border bg-content-area px-2 py-1 text-xs text-foreground">
        {label}
      </span>
    </div>
  );
}
