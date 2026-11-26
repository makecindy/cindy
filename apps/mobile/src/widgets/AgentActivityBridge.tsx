import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Linking from "expo-linking";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { remoteSessionStore } from "@/session/remoteSessionStore";
import { startForegroundTaskActivity } from "./foregroundTaskActivity";
import { projectAgentActivity } from "./agentActivity";
import { createAgentActivitySync } from "./agentActivitySync";
import {
  agentActivityNative as native,
  activityAccountScope,
  startActivityPushSync,
  type ActivityRecoveryState,
} from "./agentActivityPush";

/** Local mirroring remains the fallback for old services and self-hosted relays. */
export function AgentActivityBridge() {
  const {
    initialized,
    isAuthenticated,
    user,
    accountGeneration,
    getAccessToken,
  } = useAuth();
  const link = useDeviceLink();
  const linkRef = useRef(link);
  linkRef.current = link;
  const {
    status,
    getConnectionState,
    getPresenceAvailability,
    getSubscriptionIdentity,
    presenceVersion,
  } = link;
  const { t } = useTranslation();
  const accountId = user?.id;
  const scope =
    initialized && isAuthenticated && accountId && native?.configureAccount
      ? activityAccountScope(accountId)
      : accountId;
  const [registered, setRegistered] = useState<{
    key: string;
    hasActivity: boolean;
  } | null>(null);
  const registrationKey = `${scope}:${accountGeneration}`;
  const recovery = useMemo<ActivityRecoveryState>(() => ({}), [registrationKey]);
  // A reconnect rebuilds the syncer; it must inherit a confirmed server takeover.
  const registeredRef = useRef(registered);
  registeredRef.current = registered;
  useEffect(() => {
    if (!native || !initialized) return;
    if (native.configureAccount) {
      void native
        .configureAccount(isAuthenticated ? (scope ?? null) : null)
        .catch(() => {});
      return;
    }
    // End any previous account's activity before accepting this account's list.
    native.setState(null);
    return () => native?.setState(null);
  }, [initialized, isAuthenticated, accountId, accountGeneration, scope]);
  useEffect(() => {
    if (!native?.configureAccount || !initialized || !isAuthenticated || !scope)
      return;
    const sync = startActivityPushSync({
      recovery,
      accountScope: scope,
      getAccessToken,
      urlScheme: Linking.createURL("/").split(":")[0],
      labels: {
        attention: t("devices.companions.avatarStatus.awaiting"),
        running: t("devices.companions.avatarStatus.running"),
        completed: t("devices.companions.avatarStatus.done"),
        error: t("devices.companions.avatarStatus.error"),
        stale: t("devices.liveActivity.waitingForUpdate"),
      },
      initiallyRegistered:
        registeredRef.current?.key === registrationKey &&
        registeredRef.current.hasActivity,
      onRegistered: (hasActivity) =>
        setRegistered((previous) =>
          previous?.key === registrationKey &&
          previous.hasActivity === hasActivity
            ? previous
            : { key: registrationKey, hasActivity },
        ),
    });
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") sync.sync(true);
    });
    return () => {
      listener.remove();
      sync.dispose();
    };
  }, [
    initialized,
    isAuthenticated,
    scope,
    registrationKey,
    recovery,
    getAccessToken,
    t,
    status,
  ]);
  const refreshRoster = useRef<() => void>(() => {});
  useEffect(() => {
    const write = native?.updateForeground?.bind(native);
    if (!write || !scope || !isAuthenticated || registered?.key !== registrationKey ||
        !registered.hasActivity || status !== "online") return;
    let current: ReturnType<typeof startForegroundTaskActivity> | undefined;
    const resume = () => {
      current?.dispose();
      current = undefined;
      if (AppState.currentState !== "active") return;
      current = startForegroundTaskActivity(linkRef.current, {
        active: () => AppState.currentState === "active" && linkRef.current.status === "online",
        labels: {
          attention: t("devices.companions.avatarStatus.awaiting"),
          running: t("devices.companions.avatarStatus.running"),
          completed: t("devices.companions.avatarStatus.done"),
          error: t("devices.companions.avatarStatus.error"),
        },
        staleDetail: t("devices.liveActivity.waitingForUpdate"),
        url: (deviceId, session) => Linking.createURL(`/sessions/${encodeURIComponent(session)}`, { queryParams: { deviceId } }),
        write: (state, observedAt) => write(scope, state ? JSON.stringify(state) : null, observedAt),
      });
    };
    resume();
    refreshRoster.current = () => {
      const snapshot = linkRef.current.lastPresenceSnapshot;
      if (snapshot && current?.rosterChanged(snapshot)) resume();
    };
    const conflict = native?.addListener?.("foregroundActivityConflict", () => { void current?.recheck(); });
    const listener = AppState.addEventListener("change", resume);
    return () => {
      conflict?.remove();
      listener.remove();
      current?.dispose();
      refreshRoster.current = () => {};
    };
  }, [registered, scope, registrationKey, status, link.connectionEpoch, link.rosterVersion, isAuthenticated, t]);
  useEffect(() => refreshRoster.current(), [link.lastPresenceSnapshot]);
  const refreshLocal = useRef<() => void>(() => {});
  useEffect(() => {
    if (
      !native ||
      !initialized ||
      !isAuthenticated ||
      !accountId ||
      (native.getPushRegistration &&
        (registered?.key !== registrationKey || registered.hasActivity))
    )
      return;
    const readRegistration = native.getPushRegistration?.bind(native);
    const controller = createAgentActivitySync(() => {
      // DeviceLinkProvider clears this store and its subscription ACKs on account
      // changes. Desktop rows carry userId: '' because their database is scoped
      // to the account already; that compatibility field is not an owner ID.
      const { status, getConnectionState, getPresenceAvailability, getSubscriptionIdentity } = linkRef.current;
      const sessions = remoteSessionStore.getHomeSessions();
      const online = sessions.filter(
        (session) =>
          !!session.deviceLinkDeviceId &&
          (getConnectionState?.(session.deviceLinkDeviceId).status ??
            status) === "online" &&
          getPresenceAvailability(session.deviceLinkDeviceId) !== false &&
          (!getSubscriptionIdentity ||
            getSubscriptionIdentity(session.deviceLinkDeviceId, [
              "sessions",
            ]) !== null),
      );
      const state = projectAgentActivity(
        online,
        (session) =>
          remoteSessionStore.getSessionLiveActivity(
            session.id,
            session.deviceLinkDeviceId,
          ),
        {
          attention: t("devices.companions.avatarStatus.awaiting"),
          running: t("devices.companions.avatarStatus.running"),
          completed: t("devices.companions.avatarStatus.done"),
          error: t("devices.companions.avatarStatus.error"),
        },
        (session) =>
          Linking.createURL(`/sessions/${encodeURIComponent(session.id)}`, {
            queryParams: { deviceId: session.deviceLinkDeviceId! },
          }),
        t("devices.liveActivity.waitingForUpdate"),
      );
      // An idle online peer cannot attest that an unreachable peer has finished.
      // Prefer a displayable live activity; otherwise retain the last stale one.
      if (
        !state &&
        (status !== "online" ||
          sessions.some(
            (session) =>
              !online.includes(session) &&
              session.status === "active" &&
              session.deviceLinkDeviceId &&
              !session.cacheSeeded &&
              !session.pendingLocalCreation,
          ))
      )
        return undefined;
      return state ? JSON.stringify({ accountId: scope, state }) : null;
    }, native, () => AppState.currentState === "active",
    readRegistration
      ? async () => (await readRegistration()).isStale === true
      : undefined);
    const unsubscribe = remoteSessionStore.subscribeHomeStatus(() =>
      controller.sync(),
    );
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      clearInterval(heartbeat);
      heartbeat = undefined;
      if (AppState.currentState !== "active") return;
      controller.sync(true);
      heartbeat = setInterval(() => controller.sync(), 60_000);
    };
    refreshLocal.current = () => controller.sync();
    resume();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") resume();
      else {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
    return () => {
      refreshLocal.current = () => {};
      controller.dispose();
      clearInterval(heartbeat);
      unsubscribe();
      listener.remove();
    };
  }, [
    initialized,
    isAuthenticated,
    accountId,
    accountGeneration,
    scope,
    registered,
    registrationKey,
    t,
  ]);
  useEffect(() => refreshLocal.current(), [
    status, getConnectionState, getPresenceAvailability, getSubscriptionIdentity, presenceVersion,
  ]);
  return null;
}
