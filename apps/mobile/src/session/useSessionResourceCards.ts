import { useCallback, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  resolveRemoteText,
  type RemoteCollectionDescriptor,
  type RemoteResource,
  type RemoteResourceLink,
} from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  loadRemoteResourceManifest,
  getRemoteResource,
  invokeRemoteResourceAction,
} from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';

export function sessionResourceInputBlocked(
  resources: readonly RemoteResource[],
): boolean {
  return resources.some((resource) =>
    resource.blocks?.some(
      (block) =>
        block.primitive === 'session-controls' &&
        (block.data as { input?: unknown } | undefined)?.input !== 'available',
    ),
  );
}

interface Snapshot {
  binding: string;
  scope: string;
  resources: RemoteResource[];
  failed: boolean;
  known: boolean;
  stale?: boolean;
}

/** The host owns the workflow. Refresh reads facts; reconnect never replays actions. */
export function useSessionResourceCards(
  deviceId: string,
  deviceName: string,
  sessionId: string,
  source: string | undefined,
  running: boolean,
) {
  const router = useRouter();
  const {
    invoke,
    status,
    connectionEpoch,
    subscribe,
    unsubscribe,
    onRemoteResourceChanged,
  } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const binding = JSON.stringify([
    accountGeneration,
    deviceId,
    sessionId,
    source,
    i18n.language,
  ]);
  const scope = JSON.stringify([binding, connectionEpoch, status, running]);
  const current = useRef(scope);
  current.current = scope;
  const refresh = useRef<() => void>(() => undefined);
  const [state, setState] = useState<Snapshot>();
  const [pending, setPending] = useState<{ binding: string; id: string }>();
  const [actionError, setActionError] = useState<string>();
  const request = useRef<{ binding: string } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!deviceId || !sessionId || !source || status !== 'online') return;
      let disposed = false;
      let reading = false;
      let dirty = false;
      let generation = 0;
      let collections: RemoteCollectionDescriptor[] | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const valid = () =>
        !disposed &&
        current.current === scope &&
        AppState.currentState === 'active';
      const load = async () => {
        if (!valid() || reading) return;
        reading = true;
        dirty = false;
        const expected = generation;
        try {
          collections ??=
            (
              await loadRemoteResourceManifest(
                invoke,
                { deviceId, deviceName },
                i18n.language,
              )
            )?.collections
              .filter((item) => item.placement === 'session:' + source)
              .slice(0, 4) ?? [];
          if (!valid()) return;
          // Wait for every member before releasing the in-flight slot, even on failure.
          const results = await Promise.allSettled(
            collections.map((item) =>
              getRemoteResource(
                invoke,
                { deviceId, deviceName },
                {
                  collectionId: item.id,
                  kind: item.resourceKind,
                  id: sessionId,
                },
                i18n.language,
              ),
            ),
          );
          if (results.some((result) => result.status === 'rejected'))
            throw new Error('resource read failed');
          const resources = results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
          );
          if (valid() && expected === generation)
            setState({
              binding,
              scope,
              resources,
              failed: false,
              known: collections.length > 0,
            });
        } catch {
          if (valid() && expected === generation)
            setState((previous) => ({
              binding,
              scope,
              resources:
                previous?.binding === binding ? previous.resources : [],
              failed: true,
              known:
                !!collections?.length ||
                (previous?.binding === binding && previous.known),
            }));
        } finally {
          reading = false;
          if (valid() && dirty) schedule(false);
        }
      };
      const schedule = (invalidate = true, blockInput = false) => {
        if (!valid()) return;
        if (invalidate) {
          generation += 1;
          setState((previous) =>
            previous?.binding === binding
              ? {
                  ...previous,
                  stale: true,
                  scope: blockInput ? '' : previous.scope,
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
      void load();
      const stop = startFocusedTopicSubscription({
        deviceId,
        owner: 'session-resources:' + sessionId,
        topic: 'sessions',
        subscribe,
        unsubscribe,
      });
      const off = onRemoteResourceChanged((changedDevice, payload) => {
        if (
          changedDevice === deviceId &&
          collections?.some((item) => item.id === payload.collectionId) &&
          (!payload.resourceRefs?.length ||
            payload.resourceRefs.some(
              (ref) =>
                ref.id === sessionId &&
                collections?.some((item) => item.resourceKind === ref.kind),
            ))
        )
          schedule();
      });
      const app = AppState.addEventListener('change', (next) => {
        generation += 1;
        if (next === 'active') schedule(true, true);
        else
          setState((previous) =>
            previous?.binding === binding
              ? { ...previous, scope: '' }
              : previous,
          );
      });
      // Poll only discovered cards in the foreground; a slow read is never superseded by a timer.
      const poll = setInterval(() => {
        if (collections?.length) schedule(false);
      }, 5000);
      return () => {
        disposed = true;
        generation += 1;
        refresh.current = () => undefined;
        if (timer) clearTimeout(timer);
        clearInterval(poll);
        app.remove();
        off();
        stop();
      };
    }, [
      binding,
      scope,
      deviceId,
      deviceName,
      sessionId,
      source,
      status,
      invoke,
      subscribe,
      unsubscribe,
      onRemoteResourceChanged,
      i18n.language,
    ]),
  );

  const visible = state?.binding === binding ? state : undefined;
  const fresh =
    visible?.scope === scope &&
    status === 'online' &&
    !visible.failed &&
    !visible.stale;
  const pendingId = pending?.binding === binding ? pending.id : null;
  const latest = useRef({ visible, fresh });
  latest.current = { visible, fresh };
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, [scope]),
  );
  const act = async (resource: RemoteResource, actionId: string) => {
    const action = resource.actions?.find(
      (item) => item.id === actionId && !item.disabled,
    );
    if (
      !fresh ||
      current.current !== scope ||
      request.current?.binding === binding ||
      !action ||
      !visible?.resources.includes(resource)
    )
      return;
    const token = { binding };
    request.current = token;
    setPending({ binding, id: actionId });
    setActionError(undefined);
    try {
      if (action.confirmation) {
        const confirmation = action.confirmation;
        const accepted = await new Promise<boolean>((resolve) =>
          Alert.alert(
            resolveRemoteText(confirmation.title, i18n.language),
            confirmation.body
              ? resolveRemoteText(confirmation.body, i18n.language)
              : undefined,
            [
              {
                text: t('session.common.cancel'),
                style: 'cancel',
                onPress: () => resolve(false),
              },
              {
                text: resolveRemoteText(
                  confirmation.confirmLabel ?? action.label,
                  i18n.language,
                ),
                style:
                  action.tone === 'destructive' ? 'destructive' : 'default',
                onPress: () => resolve(true),
              },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        );
        if (
          !accepted ||
          !focused.current ||
          current.current !== scope ||
          AppState.currentState !== 'active' ||
          !latest.current.fresh
        )
          return;
        const next = latest.current.visible?.resources.find(
          (item) =>
            item.ref.collectionId === resource.ref.collectionId &&
            item.ref.kind === resource.ref.kind &&
            item.ref.id === resource.ref.id,
        );
        const nextAction = next?.actions?.find(
          (item) => item.id === actionId && !item.disabled,
        );
        if (
          !nextAction ||
          JSON.stringify(nextAction.confirmation) !==
            JSON.stringify(confirmation)
        )
          return;
      }
      await invokeRemoteResourceAction(
        invoke,
        { deviceId, deviceName },
        {
          collectionId: resource.ref.collectionId,
          resourceRef: resource.ref,
          actionId,
        },
        i18n.language,
      );
    } catch {
      if (current.current === scope) setActionError(binding);
    } finally {
      if (request.current === token) {
        request.current = null;
        setPending(undefined);
      }
      if (current.current === scope) refresh.current();
    }
  };
  return {
    resources: visible?.resources ?? [],
    failed: visible?.failed === true || actionError === binding,
    fresh: !!fresh,
    pending: pendingId,
    act,
    openLink: (resource: RemoteResource, link: RemoteResourceLink) => {
      if (
        !fresh ||
        current.current !== scope ||
        !visible?.resources.includes(resource) ||
        !resource.links.includes(link) ||
        link.target.kind !== 'session'
      )
        return;
      router.push({
        pathname: '/sessions/[sessionId]',
        params: { deviceId, sessionId: link.target.sessionId },
      });
    },
    refresh: () => {
      setActionError(undefined);
      refresh.current();
    },
    blocked:
      sessionResourceInputBlocked(visible?.resources ?? []) ||
      !!pendingId ||
      (visible?.known === true &&
        (visible.scope !== scope || status !== 'online' || visible.failed)),
    blockedReason: visible?.resources[0]
      ? resolveRemoteText(visible.resources[0].display.title, i18n.language)
      : undefined,
  };
}
