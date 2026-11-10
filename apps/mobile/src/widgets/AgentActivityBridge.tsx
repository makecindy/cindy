import { useEffect, useState } from "react";
import { AppState } from "react-native";
import * as Linking from "expo-linking";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { remoteSessionStore } from "@/session/remoteSessionStore";
import { projectAgentActivity } from "./agentActivity";
import { createAgentActivitySync } from "./agentActivitySync";
import {
  agentActivityNative as native,
  activityAccountScope,
  startActivityPushSync,
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
  const {
    status,
    getConnectionState,
    getPresenceAvailability,
    getSubscriptionIdentity,
    presenceVersion,
  } = useDeviceLink();
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
      accountScope: scope,
      getAccessToken,
      urlScheme: Linking.createURL("/").split(":")[0],
      labels: {
        attention: t("devices.companions.avatarStatus.awaiting"),
        running: t("devices.companions.avatarStatus.running"),
        completed: t("devices.companions.avatarStatus.done"),
        error: t("devices.companions.avatarStatus.error"),
        stale: t("devices.companions.stale"),
      },
      onRegistered: (hasActivity) =>
        setRegistered((previous) =>
          previous?.key === registrationKey &&
          previous.hasActivity === hasActivity
            ? previous
            : { key: registrationKey, hasActivity },
        ),
    });
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") sync.sync();
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
    getAccessToken,
    t,
    status,
  ]);
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
    const controller = createAgentActivitySync(() => {
      // DeviceLinkProvider clears this store and its subscription ACKs on account
      // changes. Desktop rows carry userId: '' because their database is scoped
      // to the account already; that compatibility field is not an owner ID.
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
        t("devices.companions.stale"),
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
    }, native);
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
    resume();
    if (AppState.currentState !== "active") controller.sync();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") resume();
      else {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
    return () => {
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
    status,
    getConnectionState,
    getPresenceAvailability,
    getSubscriptionIdentity,
    presenceVersion,
    t,
  ]);
  return null;
}
