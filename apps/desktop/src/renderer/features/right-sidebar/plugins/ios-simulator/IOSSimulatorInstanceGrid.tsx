import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  House,
  Keyboard,
  LockKeyhole,
  RotateCw,
  Send,
  Smartphone,
  UnlockKeyhole,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  IOSSimulatorFramePumpSnapshot,
  IOSSimulatorMutationState,
  IOSSimulatorStreamProfile,
} from '@cindy/ios-simulator-runtime';
import type {
  IOSSimulatorPublicInstance,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../../../../shared/iosSimulatorIpc';
import { Tip } from '@/components/ui/tooltip';

interface IOSSimulatorInstanceGridProps {
  sessionId: string;
  instances: IOSSimulatorPublicInstance[];
  mutationStates: IOSSimulatorMutationState[];
  selectedInstanceId: string | null;
  active: boolean;
  shellVisible: boolean;
  title: string;
  countLabel: string;
  onSelect: (instanceId: string) => void;
  onRefresh: () => Promise<IOSSimulatorSessionStatus | null>;
}

const BACKGROUND_PROFILE: IOSSimulatorStreamProfile = {
  framesPerSecond: 5,
  jpegQuality: 25,
  scalingPercent: 50,
};

interface TileState {
  stream: IOSSimulatorFramePumpSnapshot | null;
  frameUrl: string | null;
}

interface TileLiveMutation {
  routeKey: string;
  mutation: IOSSimulatorMutationState;
}

interface TileGesture {
  pointerId: number;
  startedAt: number;
  startClientX: number;
  startClientY: number;
  startXRatio: number;
  startYRatio: number;
}

function SimulatorIconButton({
  icon: Icon,
  label,
  disabled = false,
  disabledLabel,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  disabledLabel?: string;
  onClick: () => void;
}) {
  const accessibleLabel = disabled && disabledLabel ? `${label} — ${disabledLabel}` : label;
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-hidden={disabled ? true : undefined}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
    >
      <Icon size={12} aria-hidden="true" />
    </button>
  );

  return (
    <Tip text={accessibleLabel} side="bottom">
      {disabled ? (
        <span
          role="button"
          aria-disabled="true"
          aria-label={accessibleLabel}
          tabIndex={0}
          className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {button}
        </span>
      ) : (
        button
      )}
    </Tip>
  );
}

function routeFor(instance: IOSSimulatorPublicInstance) {
  return {
    instanceId: instance.instanceId,
    generation: instance.generation,
    leaseId: instance.lease.id,
  };
}

function routeKey(instance: IOSSimulatorPublicInstance): string {
  return `${instance.generation}:${instance.lease.id}`;
}

function streamFrom(result: IOSSimulatorToolResponse): IOSSimulatorFramePumpSnapshot | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const stream = (result.data as { stream?: unknown }).stream;
  return stream && typeof stream === 'object' ? (stream as IOSSimulatorFramePumpSnapshot) : null;
}

function instanceFrom(result: IOSSimulatorToolResponse): IOSSimulatorPublicInstance | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const instance = (result.data as { instance?: unknown }).instance;
  return instance && typeof instance === 'object' ? (instance as IOSSimulatorPublicInstance) : null;
}

function mutationFrom(result: IOSSimulatorToolResponse): IOSSimulatorMutationState | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const mutation = (result.data as { mutation?: unknown }).mutation;
  return mutation && typeof mutation === 'object' ? (mutation as IOSSimulatorMutationState) : null;
}

/** Compact multi-instance view with per-tile basic input routed by exact instance. */
export function IOSSimulatorInstanceGrid({
  sessionId,
  instances,
  mutationStates,
  selectedInstanceId,
  active,
  shellVisible,
  title,
  countLabel,
  onSelect,
  onRefresh,
}: IOSSimulatorInstanceGridProps) {
  const { t } = useTranslation();
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const [tileBusy, setTileBusy] = useState<Record<string, boolean>>({});
  const [liveMutations, setLiveMutations] = useState<Record<string, TileLiveMutation>>({});
  const [invalidatedRouteKeys, setInvalidatedRouteKeys] = useState<Record<string, string>>({});
  const [tileErrors, setTileErrors] = useState<Record<string, string>>({});
  const [tileText, setTileText] = useState<Record<string, string>>({});
  const [tileOrientation, setTileOrientation] = useState<Record<string, 'PORTRAIT' | 'LANDSCAPE'>>(
    {},
  );
  const urlsRef = useRef<Record<string, string>>({});
  const gesturesRef = useRef<Record<string, TileGesture | null>>({});
  const invalidatedRouteKeysRef = useRef<Record<string, string>>({});
  const routeRefreshStateRef = useRef({ pending: false, nextAttemptAt: 0 });
  const readyInstances = useMemo(
    () => instances.filter((instance) => instance.lifecycleState === 'ready'),
    [instances],
  );
  const viewerVisible = active && shellVisible;
  const routeIsInvalidated = useCallback(
    (instance: IOSSimulatorPublicInstance) =>
      invalidatedRouteKeysRef.current[instance.instanceId] === routeKey(instance),
    [],
  );
  const agentBusyInstanceIds = useMemo(() => {
    const busyInstanceIds = new Set(
      mutationStates
        .filter(
          (mutation) =>
            mutation.activeSource === 'agent' || (mutation.queuedAgentMutations ?? 0) > 0,
        )
        .map((mutation) => mutation.instanceId),
    );
    for (const instance of readyInstances) {
      const live = liveMutations[instance.instanceId];
      if (!live || live.routeKey !== routeKey(instance)) continue;
      if (live.mutation.activeSource === 'agent' || (live.mutation.queuedAgentMutations ?? 0) > 0) {
        busyInstanceIds.add(instance.instanceId);
      } else {
        busyInstanceIds.delete(instance.instanceId);
      }
    }
    return busyInstanceIds;
  }, [liveMutations, mutationStates, readyInstances]);
  const isTileBusy = useCallback(
    (instance: IOSSimulatorPublicInstance) =>
      instance.lifecycleState !== 'ready' ||
      tileBusy[instance.instanceId] === true ||
      agentBusyInstanceIds.has(instance.instanceId) ||
      routeIsInvalidated(instance),
    [agentBusyInstanceIds, routeIsInvalidated, tileBusy],
  );

  const callTile = useCallback(
    async (
      instance: IOSSimulatorPublicInstance,
      name:
        | 'tap'
        | 'swipe'
        | 'type_text'
        | 'press_home'
        | 'set_orientation'
        | 'lock_screen'
        | 'unlock_screen',
      args: Record<string, unknown>,
    ): Promise<boolean> => {
      if (isTileBusy(instance)) return false;
      setTileBusy((previous) => ({ ...previous, [instance.instanceId]: true }));
      setTileErrors((previous) => {
        const next = { ...previous };
        delete next[instance.instanceId];
        return next;
      });
      try {
        const result = await window.electronAPI.maker.iosSimulator.call({
          sessionId,
          name,
          args: { ...routeFor(instance), ...args },
        });
        if (!result.ok) {
          setTileErrors((previous) => ({ ...previous, [instance.instanceId]: result.message }));
          return false;
        }
        if (
          name === 'set_orientation' &&
          (args.orientation === 'PORTRAIT' || args.orientation === 'LANDSCAPE')
        ) {
          setTileOrientation((previous) => ({
            ...previous,
            [instance.instanceId]: args.orientation as 'PORTRAIT' | 'LANDSCAPE',
          }));
        }
        return true;
      } catch {
        setTileErrors((previous) => ({
          ...previous,
          [instance.instanceId]: t('rightSidebar.iosSimulator.operationError'),
        }));
        return false;
      } finally {
        setTileBusy((previous) => ({ ...previous, [instance.instanceId]: false }));
      }
    },
    [isTileBusy, sessionId, t],
  );

  const tilePoint = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      xRatio: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      yRatio: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }, []);

  const onTilePointerDown = useCallback(
    (instance: IOSSimulatorPublicInstance, event: ReactPointerEvent<HTMLImageElement>) => {
      if (event.button !== 0 || isTileBusy(instance)) return;
      const point = tilePoint(event);
      gesturesRef.current[instance.instanceId] = {
        pointerId: event.pointerId,
        startedAt: performance.now(),
        startClientX: event.clientX,
        startClientY: event.clientY,
        startXRatio: point.xRatio,
        startYRatio: point.yRatio,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [isTileBusy, tilePoint],
  );

  const onTilePointerUp = useCallback(
    (instance: IOSSimulatorPublicInstance, event: ReactPointerEvent<HTMLImageElement>) => {
      const gesture = gesturesRef.current[instance.instanceId];
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesturesRef.current[instance.instanceId] = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (isTileBusy(instance)) return;
      const end = tilePoint(event);
      const distance = Math.hypot(
        event.clientX - gesture.startClientX,
        event.clientY - gesture.startClientY,
      );
      if (distance < 8) {
        void callTile(instance, 'tap', { xRatio: end.xRatio, yRatio: end.yRatio });
        return;
      }
      const durationMs = Math.min(2_000, Math.max(100, performance.now() - gesture.startedAt));
      void callTile(instance, 'swipe', {
        startXRatio: gesture.startXRatio,
        startYRatio: gesture.startYRatio,
        endXRatio: end.xRatio,
        endYRatio: end.yRatio,
        durationMs: Math.round(durationMs),
      });
    },
    [callTile, isTileBusy, tilePoint],
  );

  const sendTileText = useCallback(
    async (instance: IOSSimulatorPublicInstance) => {
      const text = tileText[instance.instanceId] ?? '';
      if (!text) return;
      if (await callTile(instance, 'type_text', { text })) {
        setTileText((previous) => ({ ...previous, [instance.instanceId]: '' }));
      }
    },
    [callTile, tileText],
  );

  useEffect(() => {
    const currentIds = new Set(readyInstances.map((instance) => instance.instanceId));
    const currentRoutes = new Map(
      readyInstances.map((instance) => [instance.instanceId, routeKey(instance)]),
    );
    for (const [instanceId, url] of Object.entries(urlsRef.current)) {
      if (!currentIds.has(instanceId)) {
        URL.revokeObjectURL(url);
        delete urlsRef.current[instanceId];
      }
    }
    setTiles((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([instanceId]) => currentIds.has(instanceId)),
      ),
    );
    setLiveMutations((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([instanceId, live]) => currentRoutes.get(instanceId) === live.routeKey,
        ),
      ),
    );
    const retainedInvalidatedRoutes = Object.fromEntries(
      Object.entries(invalidatedRouteKeysRef.current).filter(
        ([instanceId, invalidatedRoute]) => currentRoutes.get(instanceId) === invalidatedRoute,
      ),
    );
    invalidatedRouteKeysRef.current = retainedInvalidatedRoutes;
    setInvalidatedRouteKeys(retainedInvalidatedRoutes);
    if (Object.keys(retainedInvalidatedRoutes).length === 0) {
      routeRefreshStateRef.current.nextAttemptAt = 0;
    }
  }, [readyInstances]);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    // Keep the preload bridge used by this effect stable through cleanup. The
    // global bridge can disappear while renderer teardown is still draining
    // the asynchronous visibility update.
    const simulatorApi = window.electronAPI.maker.iosSimulator;
    const requestRouteRefresh = () => {
      const refreshState = routeRefreshStateRef.current;
      if (
        cancelled ||
        refreshState.pending ||
        Object.keys(invalidatedRouteKeysRef.current).length === 0 ||
        Date.now() < refreshState.nextAttemptAt
      ) {
        return;
      }
      refreshState.pending = true;
      refreshState.nextAttemptAt = Number.POSITIVE_INFINITY;
      void Promise.resolve()
        .then(onRefresh)
        .catch(() => undefined)
        .finally(() => {
          // A returned status may lose a concurrent request-version race in
          // the parent. Only changed props clear invalidation; until then keep
          // retrying at a bounded cadence.
          refreshState.nextAttemptAt =
            Object.keys(invalidatedRouteKeysRef.current).length > 0 ? Date.now() + 500 : 0;
          refreshState.pending = false;
        });
    };
    const invalidateRoute = (instance: IOSSimulatorPublicInstance) => {
      const instanceId = instance.instanceId;
      if (cancelled || routeIsInvalidated(instance)) return;
      const hadInvalidatedRoute = Object.keys(invalidatedRouteKeysRef.current).length > 0;
      invalidatedRouteKeysRef.current = {
        ...invalidatedRouteKeysRef.current,
        [instanceId]: routeKey(instance),
      };
      if (!hadInvalidatedRoute) routeRefreshStateRef.current.nextAttemptAt = 0;
      gesturesRef.current[instanceId] = null;
      setLiveMutations((previous) => {
        if (!(instanceId in previous)) return previous;
        const next = { ...previous };
        delete next[instanceId];
        return next;
      });
      setInvalidatedRouteKeys((previous) => ({
        ...previous,
        [instanceId]: routeKey(instance),
      }));
      const previousUrl = urlsRef.current[instanceId];
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
        delete urlsRef.current[instanceId];
      }
      setTiles((previous) => ({
        ...previous,
        [instanceId]: { stream: null, frameUrl: null },
      }));
      requestRouteRefresh();
    };
    const accept = (instance: IOSSimulatorPublicInstance, result: IOSSimulatorToolResponse) => {
      if (cancelled || routeIsInvalidated(instance)) return;
      if (!result.ok) {
        if (result.errorCode === 'LEASE_EXPIRED' || result.errorCode === 'STALE_GENERATION') {
          invalidateRoute(instance);
        }
        return;
      }
      const mutation = mutationFrom(result);
      if (mutation?.instanceId === instance.instanceId) {
        setLiveMutations((previous) => ({
          ...previous,
          [instance.instanceId]: { routeKey: routeKey(instance), mutation },
        }));
      }
      // Host returns an instance only when reconcile or heartbeat advanced the
      // authoritative route. Stop using the captured generation/lease before
      // another poll or tile control can race the parent refresh.
      if (instanceFrom(result)) {
        invalidateRoute(instance);
        return;
      }
      const stream = streamFrom(result);
      const frame = stream?.latestFrame;
      if (!frame) {
        setTiles((previous) => ({
          ...previous,
          [instance.instanceId]: { ...previous[instance.instanceId], stream },
        }));
        return;
      }
      if (frame.encoding !== 'jpeg') return;
      const bytes = frame.bytes instanceof Uint8Array ? frame.bytes : new Uint8Array(frame.bytes);
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' }),
      );
      const image = new Image();
      image.onload = () => {
        if (cancelled || routeIsInvalidated(instance)) {
          URL.revokeObjectURL(url);
          return;
        }
        const previous = urlsRef.current[instance.instanceId];
        if (previous) URL.revokeObjectURL(previous);
        urlsRef.current[instance.instanceId] = url;
        setTiles((current) => ({
          ...current,
          [instance.instanceId]: { stream, frameUrl: url },
        }));
      };
      image.onerror = () => URL.revokeObjectURL(url);
      image.src = url;
    };
    const viewerTokens = new Map(
      readyInstances.map((instance) => [instance.instanceId, window.crypto.randomUUID()]),
    );
    const setVisibility = async (visible: boolean) => {
      await Promise.all(
        readyInstances.map(async (instance) => {
          const route = {
            sessionId,
            ...routeFor(instance),
            visible,
            preferredEncoding: 'jpeg' as const,
            viewerToken: viewerTokens.get(instance.instanceId)!,
          };
          const result = await simulatorApi.setViewerVisibility(route).catch(() => null);
          if (cancelled) return;
          if (visible && result) accept(instance, result);
          if (
            visible &&
            !routeIsInvalidated(instance) &&
            instance.instanceId !== selectedInstanceId
          ) {
            await simulatorApi
              .setStreamProfile({
                sessionId,
                ...routeFor(instance),
                viewerToken: viewerTokens.get(instance.instanceId)!,
                profile: BACKGROUND_PROFILE,
              })
              .catch(() => undefined);
          }
        }),
      );
    };
    const poll = async () => {
      if (!viewerVisible || polling || cancelled) return;
      polling = true;
      try {
        requestRouteRefresh();
        await Promise.all(
          readyInstances.map(async (instance) => {
            if (routeIsInvalidated(instance)) return;
            const result = await simulatorApi.latestFrame({
              sessionId,
              ...routeFor(instance),
            });
            accept(instance, result);
          }),
        );
      } finally {
        polling = false;
      }
    };
    void setVisibility(viewerVisible);
    void poll();
    const timer = viewerVisible ? window.setInterval(() => void poll(), 500) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      void setVisibility(false);
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
      urlsRef.current = {};
    };
  }, [onRefresh, readyInstances, routeIsInvalidated, selectedInstanceId, sessionId, viewerVisible]);

  if (readyInstances.length < 2) return null;

  return (
    <section
      aria-label={title}
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-12 font-medium">{title}</h3>
        <span className="text-10 text-[var(--text-secondary)]">{countLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {readyInstances.map((instance) => {
          const tile = tiles[instance.instanceId];
          const selected = instance.instanceId === selectedInstanceId;
          const agentBusy = agentBusyInstanceIds.has(instance.instanceId);
          const routeInvalidated = invalidatedRouteKeys[instance.instanceId] === routeKey(instance);
          const busy = isTileBusy(instance);
          const controlsUnavailableLabel = agentBusy
            ? t('rightSidebar.iosSimulator.agentBusyDescription')
            : t('rightSidebar.iosSimulator.controlsUnavailable');
          const textToSend = tileText[instance.instanceId] ?? '';
          const error = tileErrors[instance.instanceId];
          return (
            <article
              key={instance.instanceId}
              className={`overflow-hidden rounded-xl border text-left ${selected ? 'border-[var(--focus-ring)]' : 'border-[var(--border-default)]'}`}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(instance.instanceId)}
                className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
              >
                <div className="relative flex aspect-[9/16] items-center justify-center bg-[var(--surface)]">
                  {tile?.frameUrl ? (
                    <img
                      src={tile.frameUrl}
                      alt={instance.simulatorName}
                      className={`max-h-full max-w-full touch-none select-none object-contain ${busy ? 'cursor-wait opacity-70' : ''}`}
                      draggable={false}
                      onPointerDown={(event) => onTilePointerDown(instance, event)}
                      onPointerUp={(event) => onTilePointerUp(instance, event)}
                      onPointerCancel={() => {
                        gesturesRef.current[instance.instanceId] = null;
                      }}
                    />
                  ) : (
                    <Smartphone
                      size={20}
                      className="text-[var(--text-secondary)]"
                      aria-hidden="true"
                    />
                  )}
                  <span className="absolute inset-x-1 bottom-1 truncate rounded-lg bg-[var(--surface-chip)] px-1.5 py-1 text-10 text-[var(--text-primary)]">
                    {instance.simulatorName}
                  </span>
                </div>
              </button>
              <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-default)] bg-[var(--surface-elevated)] p-2">
                <div className="relative min-w-0 flex-1">
                  <Keyboard
                    size={12}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
                    aria-hidden="true"
                  />
                  <input
                    value={tileText[instance.instanceId] ?? ''}
                    onChange={(event) =>
                      setTileText((previous) => ({
                        ...previous,
                        [instance.instanceId]: event.target.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.nativeEvent.isComposing &&
                        !event.shiftKey
                      ) {
                        event.preventDefault();
                        void sendTileText(instance);
                      }
                    }}
                    disabled={busy}
                    aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.textInputLabel')}`}
                    placeholder={t('rightSidebar.iosSimulator.textInputPlaceholder')}
                    className="h-7 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] pl-7 pr-2 text-10 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                  />
                </div>
                <SimulatorIconButton
                  icon={Send}
                  label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.sendText')}`}
                  disabled={busy || !textToSend}
                  disabledLabel={
                    busy
                      ? controlsUnavailableLabel
                      : t('rightSidebar.iosSimulator.enterTextBeforeSending')
                  }
                  onClick={() => void sendTileText(instance)}
                />
                <SimulatorIconButton
                  icon={House}
                  label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.pressHome')}`}
                  disabled={busy}
                  disabledLabel={controlsUnavailableLabel}
                  onClick={() => void callTile(instance, 'press_home', {})}
                />
                <SimulatorIconButton
                  icon={RotateCw}
                  label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.rotateDevice')}`}
                  disabled={busy}
                  disabledLabel={controlsUnavailableLabel}
                  onClick={() =>
                    void callTile(instance, 'set_orientation', {
                      orientation:
                        tileOrientation[instance.instanceId] === 'LANDSCAPE'
                          ? 'PORTRAIT'
                          : 'LANDSCAPE',
                    })
                  }
                />
                <SimulatorIconButton
                  icon={LockKeyhole}
                  label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.lockScreen')}`}
                  disabled={busy}
                  disabledLabel={controlsUnavailableLabel}
                  onClick={() => void callTile(instance, 'lock_screen', {})}
                />
                <SimulatorIconButton
                  icon={UnlockKeyhole}
                  label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.unlockScreen')}`}
                  disabled={busy}
                  disabledLabel={controlsUnavailableLabel}
                  onClick={() => void callTile(instance, 'unlock_screen', {})}
                />
              </div>
              {agentBusy && (
                <div className="border-t border-[var(--border-default)] px-2 py-1 text-10 text-[var(--warning-accent)]">
                  {t('rightSidebar.iosSimulator.agentBusyTitle')}
                </div>
              )}
              {error && (
                <div
                  role="alert"
                  className="border-t border-[var(--border-default)] px-2 py-1 text-10 text-[var(--text-secondary)]"
                >
                  {error}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
