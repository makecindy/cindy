import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isSharedTaskPeer,
  parseRemoteResourceChangedPayload,
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  resolveRemoteText,
} from '@cindy/device-link';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';
import {
  parseSessionResource,
  sessionResourceClient,
  sessionResourceCollections,
  sessionResourceInputBlocked,
  type SessionResource,
  type SessionResourceCollection,
} from './sessionResources';

interface Snapshot {
  binding: string;
  scope: object | undefined;
  resources: SessionResource[];
  supported: boolean;
  failed: boolean;
  stale?: boolean;
}

/** A projection of host-owned state; reconnect only reads and never replays writes. */
export function useSessionResourceCards({
  deviceId,
  sessionId,
  source,
  connected,
  active = true,
  readOnly = false,
  running,
}: {
  deviceId?: string;
  sessionId?: string;
  source?: string;
  connected: boolean;
  active?: boolean;
  readOnly?: boolean;
  running: boolean;
}) {
  const { i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const owner = getDataOwnerGeneration();
  const enabled = !!deviceId && !isSharedTaskPeer(deviceId) && !!sessionId && !!source;
  const binding = JSON.stringify([owner, deviceId, sessionId, source, i18n.language]);
  // Identity must not repeat after disconnect -> reconnect with the same inputs.
  const scope = useMemo(
    () => ({ binding, connected, active, readOnly, running }),
    [binding, connected, active, readOnly, running],
  );
  const current = useRef(scope);
  current.current = scope;
  const [state, setState] = useState<Snapshot>();
  const [pending, setPending] = useState<{ binding: string; id: string }>();
  const [actionError, setActionError] = useState<string>();
  const request = useRef<{ binding: string } | null>(null);
  const refresh = useRef<() => void>(() => undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // Mutable freshness closes the push -> React render window for action handlers.
  const ready = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    ready.current = false;
    if (!enabled || !connected || !active) return () => controller.abort();
    const api = window.electronAPI.deviceLink;
    const client = sessionResourceClient(i18n.language);
    let collections: SessionResourceCollection[] | undefined;
    let reading = false;
    let dirty = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () =>
      !controller.signal.aborted &&
      current.current === scope &&
      isDataOwnerGenerationCurrent(owner) &&
      document.visibilityState !== 'hidden';
    const load = async () => {
      if (!valid() || reading) return;
      reading = true;
      dirty = false;
      const expected = generation;
      try {
        if (!collections) {
          try {
            const raw = await api.invoke(deviceId!, REMOTE_RESOURCE_MANIFEST_CHANNEL, [{ client }]);
            if (!valid()) return;
            collections = sessionResourceCollections(raw, source!);
          } catch (error) {
            // Old hosts lack the allowlisted channel. Preserve their read-only history.
            const code = extractIpcError(error)?.code ?? (error as { code?: string } | null)?.code;
            if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'CHANNEL_NOT_ALLOWED')
              collections = [];
            else throw error;
          }
        }
        if (!valid()) return;
        const results = await Promise.allSettled(
          collections.map(async (item) => {
            const ref = { collectionId: item.id, kind: item.resourceKind, id: sessionId! };
            return parseSessionResource(
              await api.invoke(deviceId!, REMOTE_RESOURCE_GET_CHANNEL, [{ client, ref }]),
              ref,
            );
          }),
        );
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (valid() && generation === expected) {
          ready.current = true;
          setActionError(undefined);
          setState({
            binding,
            scope,
            supported: collections.length > 0,
            failed: false,
            resources: results.flatMap((result) =>
              result.status === 'fulfilled' ? [result.value] : [],
            ),
          });
        }
      } catch {
        if (valid() && generation === expected) {
          ready.current = false;
          setState((previous) => ({
            binding,
            scope,
            supported: true,
            failed: true,
            resources: previous?.binding === binding ? previous.resources : [],
          }));
        }
      } finally {
        reading = false;
        if (valid() && dirty) schedule(false);
      }
    };
    const schedule = (invalidate = true, blockInput = false) => {
      if (!valid()) return;
      if (invalidate) {
        generation += 1;
        ready.current = false;
        setState((previous) =>
          previous?.binding === binding
            ? {
                ...previous,
                stale: true,
                scope: blockInput ? undefined : previous.scope,
              }
            : previous,
        );
      }
      if (reading) {
        if (invalidate) dirty = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, 150);
    };
    refresh.current = () => schedule(true, true);
    // The desktop remote-session synchronizer already owns the sessions topic.
    const off = api.onRemotePush((push, stamp) => {
      if (
        !valid() ||
        push.deviceId !== deviceId ||
        push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL ||
        !isDeviceLinkRemotePushCurrent(push, stamp)
      )
        return;
      const changed = parseRemoteResourceChangedPayload(push.payload);
      if (
        changed &&
        (!collections || collections.some((item) => item.id === changed.collectionId)) &&
        (!changed.resourceRefs?.length ||
          changed.resourceRefs.some(
            (ref) =>
              ref.id === sessionId &&
              (!collections ||
                collections.some(
                  (item) => item.id === ref.collectionId && item.resourceKind === ref.kind,
                )),
          ))
      )
        schedule();
    });
    const visibility = () => {
      generation += 1;
      ready.current = false;
      if (document.visibilityState !== 'hidden') schedule();
      else
        setState((previous) =>
          previous?.binding === binding ? { ...previous, stale: true } : previous,
        );
    };
    document.addEventListener('visibilitychange', visibility);
    void load();
    // Bound foreground recovery for missed pushes. Slow reads are never overlapped.
    const poll = setInterval(() => {
      if (collections?.length) schedule(false);
    }, 5000);
    return () => {
      controller.abort();
      ready.current = false;
      refresh.current = () => undefined;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      off();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled, scope, binding, connected, active, deviceId, sessionId, source, i18n.language]);

  const visible = enabled && state?.binding === binding ? state : undefined;
  const fresh =
    !!visible &&
    visible.scope === scope &&
    !visible.failed &&
    !visible.stale &&
    connected &&
    active;
  const latest = useRef({ visible, fresh });
  latest.current = { visible, fresh };
  const pendingId = pending?.binding === binding ? pending.id : null;
  const act = async (resource: SessionResource, actionId: string) => {
    const action = resource.actions.find((item) => item.id === actionId && !item.disabled);
    const signal = lifetime.current?.signal;
    const valid = () =>
      !signal?.aborted &&
      current.current === scope &&
      isDataOwnerGenerationCurrent(owner) &&
      document.visibilityState !== 'hidden' &&
      ready.current &&
      latest.current.fresh;
    if (
      !signal ||
      !enabled ||
      readOnly ||
      !valid() ||
      request.current?.binding === binding ||
      !action ||
      !latest.current.visible?.resources.includes(resource)
    )
      return;
    const token = { binding };
    request.current = token;
    setPending({ binding, id: actionId });
    setActionError(undefined);
    let invoked = false;
    try {
      if (action.confirmation) {
        const resolve = (value: Parameters<typeof resolveRemoteText>[0]) =>
          resolveRemoteText(value, i18n.language);
        const accepted = await confirm(
          {
            presentation: 'standard',
            title: resolve(action.confirmation.title),
            description: action.confirmation.body ? resolve(action.confirmation.body) : undefined,
            confirmText: resolve(action.confirmation.confirmLabel ?? action.label),
            confirmVariant: action.tone === 'destructive' ? 'destructive' : 'default',
          },
          signal,
        );
        if (!accepted || !valid()) return;
        const next = latest.current.visible?.resources.find(
          (item) =>
            item.ref.collectionId === resource.ref.collectionId &&
            item.ref.kind === resource.ref.kind &&
            item.ref.id === resource.ref.id,
        );
        const nextAction = next?.actions.find((item) => item.id === actionId && !item.disabled);
        if (!nextAction || JSON.stringify(nextAction) !== JSON.stringify(action)) return;
      }
      invoked = true;
      await window.electronAPI.deviceLink.invoke(deviceId!, REMOTE_RESOURCE_INVOKE_CHANNEL, [
        {
          client: sessionResourceClient(i18n.language),
          collectionId: resource.ref.collectionId,
          resourceRef: resource.ref,
          actionId,
        },
      ]);
    } catch {
      if (!signal.aborted && current.current === scope && isDataOwnerGenerationCurrent(owner))
        setActionError(binding);
    } finally {
      if (request.current === token) {
        request.current = null;
        setPending(undefined);
      }
      if (invoked && !signal.aborted && current.current === scope) refresh.current();
    }
  };
  return {
    resources: visible?.resources ?? [],
    supported: visible?.supported === true,
    handlesSession: enabled && visible?.supported !== false,
    fresh,
    readOnly,
    connected,
    pending: pendingId,
    act,
    failed: visible?.failed === true || actionError === binding,
    blocked:
      enabled &&
      visible?.supported !== false &&
      (!visible ||
        visible.scope !== scope ||
        !connected ||
        visible.failed ||
        sessionResourceInputBlocked(visible.resources) ||
        !!pendingId),
    refresh: () => {
      setActionError(undefined);
      refresh.current();
    },
  };
}
