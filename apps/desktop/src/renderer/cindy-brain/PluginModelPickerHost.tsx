import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { WebviewTag } from 'electron';
import { ModelRouteSelectorContent } from '@/components/new-chat/ModelRouteSelector';
import { modelCatalogKey } from '../../shared/controlledModelCatalog';
import { useTransientModelPickerPreferences } from '@/components/new-chat/modelPickerPreferences';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { refreshLocalCatalogSnapshot } from '@/lib/localCatalogSnapshot';
import type { Effort } from '@/lib/userPreferences.types';
import type {
  PluginModelPickerRequest,
  PluginModelPickerPresentation,
  PluginModelPickerRoute,
} from '../../shared/pluginModelPicker';

/** The page supplies only an anchor. The Host owns catalogs, favorites and all selector UI. */
export function PluginModelPickerPopover({
  request,
  onAnswer,
}: {
  request: PluginModelPickerPresentation;
  onAnswer(route: PluginModelPickerRoute | null): Promise<{ handled: boolean; accepted: boolean }>;
}) {
  const { t } = useTranslation();
  const [route, setRoute] = useState(request.initial);
  const draft = useRef(request.initial);
  const settled = useRef(false);
  const [error, setError] = useState(false);
  const lock = useRef<'selection' | 'cancel' | null>(null);
  const answerSequence = useRef(0);
  const preferenceStore = useTransientModelPickerPreferences();
  const agents = useModelPickerAgents(
    route?.agentKind === 'cc' ? 'claude-code' : (route?.agentKind ?? 'codex'),
    modelCatalogKey(route?.agentDeviceId),
  );
  const [anchor, setAnchor] = useState<DOMRect>();
  const answerRef = useRef(onAnswer);
  answerRef.current = onAnswer;
  useEffect(() => {
    const page = request.pageAnchor!;
    const guest = [...document.querySelectorAll('webview')].find((node) => {
      try {
        return (node as WebviewTag).getWebContentsId() === page.guestId;
      } catch {
        return false;
      }
    }) as WebviewTag | undefined;
    if (!guest) {
      void answerRef.current(null);
      return;
    }
    const bounds = guest.getBoundingClientRect();
    const { x, y, width, height } = page.rect;
    const scale = page.zoomFactor ?? 1;
    // Never display an anchor from a different/hidden page or outside this guest's viewport.
    if (
      !bounds.width ||
      !bounds.height ||
      x < 0 ||
      y < 0 ||
      (x + width) * scale > bounds.width + 1 ||
      (y + height) * scale > bounds.height + 1
    ) {
      void answerRef.current(null);
      return;
    }
    setAnchor(
      new DOMRect(bounds.x + x * scale, bounds.y + y * scale, width * scale, height * scale),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    const close = () => {
      void answerRef.current(null);
    };
    const observer = new ResizeObserver(() => {
      const next = guest.getBoundingClientRect();
      if (
        next.width !== bounds.width ||
        next.height !== bounds.height ||
        next.x !== bounds.x ||
        next.y !== bounds.y
      )
        close();
    });
    const scroll = (event: Event) => {
      if (
        event.target === document ||
        event.target === window ||
        (event.target instanceof Element && event.target.contains(guest))
      )
        close();
    };
    observer.observe(guest);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [request.requestId]);
  const answer = async (value: PluginModelPickerRoute | null) => {
    if (settled.current) return true;
    // Cancellation must reach Main even while a remote source is being checked.
    // Its reply supersedes the in-flight selection, whose late result cannot change this UI.
    if (lock.current && (value !== null || lock.current === 'cancel')) return false;
    const sequence = ++answerSequence.current;
    lock.current = value === null ? 'cancel' : 'selection';
    setError(false);
    try {
      const result = await onAnswer(value);
      if (sequence !== answerSequence.current) return false;
      const accepted = result.handled && result.accepted;
      settled.current = accepted;
      if (!accepted) setError(true);
      return accepted;
    } catch {
      if (sequence !== answerSequence.current) return false;
      setError(true);
      return false;
    } finally {
      if (sequence === answerSequence.current) lock.current = null;
    }
  };
  const update = (value: PluginModelPickerRoute) => {
    draft.current = value;
    setRoute(value);
  };
  const close = () => {
    // Parameter edits apply on dismissal; an untouched picker returns cancellation.
    void answer(
      draft.current && JSON.stringify(draft.current) !== JSON.stringify(request.initial)
        ? draft.current
        : null,
    );
  };
  if (!anchor) return null;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: anchor.x,
            top: anchor.y,
            width: anchor.width,
            height: anchor.height,
            pointerEvents: 'none',
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          void answer(null);
        }}
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        style={{ zIndex: 10000 }}
        className="flex min-h-0 w-auto max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden rounded-xl border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-0"
      >
        <ModelRouteSelectorContent
          sshRemote={!request.allowRemote}
          preferenceStore={preferenceStore}
          agentDeviceId={route?.agentDeviceId}
          modelId={route?.model ?? ''}
          currentProviderId={route?.providerId ?? null}
          vendorKey={route?.agentKind}
          effort={(route?.effort ?? '') as Effort}
          fastMode={route?.fastMode ?? false}
          unifiedAgents={agents}
          overlayContentClassName="z-[10001]"
          onModelChange={() => false}
          onEffortChange={(effort) => {
            if (draft.current) update({ ...draft.current, effort });
          }}
          onFastModeChange={(fastMode) => {
            if (draft.current) update({ ...draft.current, fastMode });
          }}
          onDismiss={close}
          onUnifiedSelect={async ({ providerId, modelId, engine, effort, fast, agentDevice }) => {
            const next = {
              ...(agentDevice?.deviceId ? { agentDeviceId: agentDevice.deviceId } : {}),
              providerId,
              model: modelId,
              agentKind: engine,
              effort: effort ?? '',
              fastMode: fast,
            };
            update(next);
            return answer(next);
          }}
        />
        {error && (
          <ErrorNotice className="m-3" message={t('settings.ghosts.modelPicker.unavailable')} />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Host-owned presentation: selecting and editing only changes this dialog's draft. */
export function PluginModelPickerDialog({
  request,
  deviceId,
  onAnswer,
}: {
  request: PluginModelPickerRequest;
  deviceId?: string;
  onAnswer(route: PluginModelPickerRoute | null): Promise<{ handled: boolean; accepted: boolean }>;
}) {
  const { t } = useTranslation();
  const [route, setRoute] = useState(request.initial);
  const preferenceStore = useTransientModelPickerPreferences(deviceId);
  const agents = useModelPickerAgents(
    route?.agentKind === 'cc' ? 'claude-code' : (route?.agentKind ?? 'codex'),
    modelCatalogKey(route?.agentDeviceId ?? deviceId, deviceId),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const lock = useRef(false);
  const answer = async (value: PluginModelPickerRoute | null) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await onAnswer(value);
      if (!result.handled || !result.accepted) setError(true);
    } catch {
      setError(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      title={t('settings.ghosts.modelPicker.title', { name: request.ghostName })}
      confirmText={t('settings.ghosts.modelPicker.useConfiguration')}
      maxWidth={460}
      confirmDisabled={!route}
      loading={busy}
      onConfirm={() => {
        void answer(route ?? null);
      }}
      onCancel={() => {
        void answer(null);
      }}
      onOpenChange={(open) => {
        if (!open && !lock.current) void answer(null);
      }}
      content={
        <>
          <ModelRouteSelectorContent
            sshRemote={!request.allowRemote}
            preferenceStore={preferenceStore}
            deviceId={deviceId}
            agentDeviceId={route?.agentDeviceId}
            modelId={route?.model ?? ''}
            currentProviderId={route?.providerId ?? null}
            vendorKey={route?.agentKind}
            effort={(route?.effort ?? '') as Effort}
            fastMode={route?.fastMode ?? false}
            unifiedAgents={agents}
            overlayContentClassName="z-[10001]"
            onModelChange={() => false}
            onEffortChange={(effort) => {
              setRoute((r) => (r ? { ...r, effort } : r));
            }}
            onFastModeChange={(fastMode) => {
              setRoute((r) => (r ? { ...r, fastMode } : r));
            }}
            onUnifiedSelect={({ providerId, modelId, engine, effort, fast, agentDevice }) => {
              setRoute({
                ...(agentDevice?.deviceId ? { agentDeviceId: agentDevice.deviceId } : {}),
                providerId,
                model: modelId,
                agentKind: engine,
                effort: effort ?? '',
                fastMode: fast,
              });
              setError(false);
              return true;
            }}
          />
          {error && (
            <ErrorNotice className="mt-3" message={t('settings.ghosts.modelPicker.unavailable')} />
          )}
        </>
      }
    />
  );
}

export function PluginModelPickerHost({
  bootstrapCatalog = false,
}: { bootstrapCatalog?: boolean } = {}) {
  const [request, setRequest] = useState<PluginModelPickerPresentation>();
  const active = useRef<PluginModelPickerPresentation | undefined>(undefined);
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    if (!bootstrapCatalog || !request) return;
    // Detached windows do not mount App's catalog subscription. Use the same atomic reader here.
    const refresh = () => {
      void refreshLocalCatalogSnapshot();
    };
    refresh();
    const providers = window.electronAPI.maker.onProvidersChanged(refresh);
    const agents = window.electronAPI.maker.onAgentsChanged?.(refresh);
    return () => {
      providers();
      agents?.();
    };
  }, [bootstrapCatalog, request?.requestId]);
  useEffect(() => {
    const api = window.electronAPI.ghosts;
    const off = api.onModelPickerRequest?.((next) => {
      if (dismissed.current.has(next.requestId)) return;
      if (active.current) {
        if (active.current.requestId !== next.requestId) {
          const answer = next.remoteViewId
            ? api.answerRemoteModelPicker(next.remoteViewId, next.requestId, null)
            : api.resolveModelPicker(next.requestId, null);
          void answer.catch(() => {});
        }
        return;
      }
      active.current = next;
      setRequest(next);
    });
    const dismiss = api.onModelPickerDismissed?.(({ requestId }) => {
      dismissed.current.add(requestId);
      if (dismissed.current.size > 64)
        dismissed.current.delete(dismissed.current.values().next().value!);
      if (active.current?.requestId === requestId) active.current = undefined;
      setRequest((value) => (value?.requestId === requestId ? undefined : value));
    });
    return () => {
      off?.();
      dismiss?.();
    };
  }, []);
  return request ? (
    <PluginModelPickerPresentationView
      key={request.requestId}
      request={request}
      deviceId={request.deviceId}
      onAnswer={(route) =>
        request.remoteViewId
          ? window.electronAPI.ghosts.answerRemoteModelPicker(
              request.remoteViewId,
              request.requestId,
              route,
            )
          : window.electronAPI.ghosts.resolveModelPicker(request.requestId, route)
      }
    />
  ) : null;
}

function PluginModelPickerPresentationView(
  props: Parameters<typeof PluginModelPickerPopover>[0] & { deviceId?: string },
) {
  return props.request.pageAnchor ? (
    <PluginModelPickerPopover {...props} />
  ) : (
    <PluginModelPickerDialog {...props} />
  );
}
