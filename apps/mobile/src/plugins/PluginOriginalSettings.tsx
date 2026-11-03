import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useTranslation } from "react-i18next";
import {
  PLUGIN_OAUTH_CHANNEL,
  type PluginDirectoryRequest,
  type PluginOauthAction,
} from "@cindy/device-link";
import { useAuth } from "@/auth/AuthContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { spacing, useTheme } from "@/theme";
import { PluginNotice } from "./PluginNotice";
import { PluginSettingsCard } from "./PluginSettingsCard";
import { PluginDirectoryPicker } from "./PluginDirectoryPicker";
import { openMobilePluginOauthSession } from "./pluginOauthSession";
import { runMobilePluginAuthorization } from "./pluginAuthorizationController";
import { receiveMobilePluginOauthLoopback } from "./pluginOauthLoopbackNative";
import { pluginOauthPlatformCrypto } from "./pluginOauthPlatformCrypto";
import type { PluginSettingsIdentity } from "./pluginSettingsClient";

/** Native prompts and the original author page share one captured target and owner. */
export function PluginOriginalSettings({
  identity,
  active,
  onNotice,
}: {
  identity: PluginSettingsIdentity;
  active: boolean;
  onNotice(text: string): void;
}) {
  const auth = useAuth(),
    link = useDeviceLink(),
    { t } = useTranslation(),
    { colors } = useTheme();
  const owner = useRef(getMobileAuthOwner()).current;
  const captured = useRef({ ...identity, epoch: link.connectionEpoch }).current;
  const live = useRef({ identity, active, epoch: link.connectionEpoch });
  live.current = { identity, active, epoch: link.connectionEpoch };
  const alive = useRef(true);
  const pending = useRef(new Set<() => void>());
  const authorizationFailure = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [cardUnavailable, setCardUnavailable] = useState(false);
  const [localError, setLocalError] = useState<{
    title: string;
    detail: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const [directory, setDirectory] = useState<{
    request: PluginDirectoryRequest;
    resolve(path: string | null): void;
  }>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const cancel of pending.current) cancel();
      pending.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!active) for (const cancel of Array.from(pending.current)) cancel();
  }, [active]);
  const assertIdentityCurrent = () => {
    const current = live.current;
    if (
      !isMobileAuthOwnerCurrent(owner) ||
      current.epoch !== captured.epoch ||
      current.identity.deviceId !== captured.deviceId ||
      current.identity.instanceId !== captured.instanceId ||
      current.identity.expectedInstalledApproval !==
        captured.expectedInstalledApproval
    )
      throw new Error("PLUGIN_SETTINGS_CLOSED");
  };
  const assertCurrent = () => {
    assertIdentityCurrent();
    if (!alive.current || !live.current.active)
      throw new Error("PLUGIN_SETTINGS_CLOSED");
  };
  const confirm = (
    title: string,
    body: string,
    yes: string,
    no: string,
    danger = false,
    expiresAt?: number,
  ) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.current.delete(cancel);
        try {
          assertCurrent();
          resolve(accepted && (!expiresAt || Date.now() < expiresAt));
        } catch {
          resolve(false);
        }
      };
      const cancel = () => finish(false);
      pending.current.add(cancel);
      if (expiresAt)
        timer = setTimeout(cancel, Math.max(0, expiresAt - Date.now()));
      Alert.alert(
        title,
        body,
        [
          { text: no, style: "cancel", onPress: cancel },
          {
            text: yes,
            style: danger ? "destructive" : "default",
            onPress: () => finish(true),
          },
        ],
        { cancelable: true, onDismiss: cancel },
      );
    });
  const openSession = async (action: PluginOauthAction) => {
    assertCurrent();
    if (!auth.deviceId) throw new Error("PLUGIN_SETTINGS_CLOSED");
    return openMobilePluginOauthSession({
      deviceId: captured.deviceId,
      peer: auth.deviceId,
      owner,
      ghostId: captured.instanceId,
      action,
      assertCurrent: assertIdentityCurrent,
      invoke: (raw) =>
        link.invoke(captured.deviceId, PLUGIN_OAUTH_CHANNEL, [raw], {
          preSend: assertIdentityCurrent,
        }),
    });
  };
  const authorize = async (action: PluginOauthAction) => {
    assertCurrent();
    authorizationFailure.current = undefined;
    setLocalError(undefined);
    setFailed(false);
    const session = await openSession(action);
    try {
      await runMobilePluginAuthorization({
        crypto: pluginOauthPlatformCrypto,
        kind: "oauth",
        action,
        invoke: session.request,
        assertCurrent,
        clearInput() {},
        receiveLoopback: async (request, expiresAt, signal) => {
          assertCurrent();
          const accepted = await confirm(
            t("plugins.connectAccount"),
            new URL(request.url).hostname,
            t("plugins.open"),
            t("plugins.cancel"),
            false,
            expiresAt,
          );
          assertCurrent();
          if (!accepted)
            throw new Error("PLUGIN_SETTINGS_AUTHORIZATION_CANCELLED");
          return receiveMobilePluginOauthLoopback(
            request,
            expiresAt,
            assertCurrent,
            signal,
          );
        },
        isForeground: () => AppState.currentState === "active",
        pause: async () => {
          do {
            await new Promise((resolve) => setTimeout(resolve, 600));
            assertCurrent();
          } while (AppState.currentState !== "active");
        },
        showAuthorization: async (url, code, expiresAt) => {
          assertCurrent();
          const accepted = await confirm(
            t("plugins.connectAccount"),
            new URL(url).hostname + (code ? "\n" + code : ""),
            t("plugins.open"),
            t("plugins.cancel"),
            false,
            expiresAt,
          );
          assertCurrent();
          if (!accepted)
            throw new Error("PLUGIN_SETTINGS_AUTHORIZATION_CANCELLED");
          await WebBrowser.openBrowserAsync(url, { showTitle: true });
          assertCurrent();
        },
      });
    } catch (error) {
      assertCurrent();
      // Card forwards only a sanitized code in a new Error instance.
      authorizationFailure.current =
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : "PLUGIN_SETTINGS_UNAVAILABLE";
      throw error;
    } finally {
      session.dispose();
    }
  };
  return (
    <View testID="plugins.originalSettings" style={{ gap: spacing.md }}>
      {localError ? (
        <PluginNotice
          compact
          unavailable={cardUnavailable}
          testID="plugins.settingsError"
          title={localError.title}
          detail={
            localError.title === t("plugins.notice.title.readFailed")
              ? undefined
              : localError.detail
          }
          icon="warning"
          actions={
            failed
              ? [
                  {
                    label: t("plugins.management.settingsReload"),
                    testID: "plugins.settingsReload",
                    disabled: !active,
                    onPress: () => {
                      setFailed(false);
                      setLocalError(undefined);
                      setAttempt((value) => value + 1);
                    },
                  },
                ]
              : undefined
          }
        />
      ) : null}
      <View
        style={
          cardUnavailable
            ? { height: 0, overflow: "hidden" }
            : { minHeight: loading ? 80 : undefined }
        }
      >
        <View
          pointerEvents={loading ? "none" : "auto"}
          accessibilityElementsHidden={loading}
          importantForAccessibility={loading ? "no-hide-descendants" : "auto"}
          style={{ opacity: loading ? 0 : 1 }}
        >
          <PluginSettingsCard
            key={attempt}
            identity={identity}
            active={active}
            generation={
              String(auth.accountGeneration) + ":" + link.connectionEpoch
            }
            assertCurrent={assertCurrent}
            assertCleanupCurrent={assertIdentityCurrent}
            openSession={openSession}
            invokeTarget={(channel, args) =>
              link.invoke(captured.deviceId, channel, args, {
                preSend: assertCurrent,
              })
            }
            onAuthorize={authorize}
            onOpenLink={async (raw, checkPage) => {
              checkPage();
              assertCurrent();
              if (raw.length > 8192 || /[\x00-\x20\\]/.test(raw))
                throw new Error("PLUGIN_SETTINGS_LINK_UNAVAILABLE");
              const url = new URL(raw);
              if (
                !["https:", "http:"].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw new Error("PLUGIN_SETTINGS_LINK_UNAVAILABLE");
              // A target computer's loopback URL is not a service on this phone.
              const host = url.hostname.toLowerCase().replace(/\.$/, "");
              if (
                host === "localhost" ||
                host.endsWith(".localhost") ||
                /^127\./.test(host) ||
                host === "[::1]" ||
                host === "0.0.0.0"
              ) {
                onNotice(t("plugins.settingsComputerLink"));
                return;
              }
              const accepted = await confirm(
                t("plugins.externalTitle"),
                url.hostname,
                t("plugins.open"),
                t("plugins.cancel"),
              );
              checkPage();
              assertCurrent();
              if (accepted)
                await WebBrowser.openBrowserAsync(url.toString(), {
                  showTitle: true,
                });
            }}
            onLoading={(value) => {
              setLoading(value);
              if (value) {
                setCardUnavailable(false);
                authorizationFailure.current = undefined;
                setFailed(false);
                setLocalError(undefined);
              }
            }}
            onNotice={(notice) => {
              try {
                assertCurrent();
              } catch {
                return;
              }
              onNotice(notice);
            }}
            onError={(error, context = "load", reportedToPage = false) => {
              try {
                assertCurrent();
              } catch {
                return;
              }
              if (error.message === "PLUGIN_SETTINGS_LINK_UNAVAILABLE") {
                onNotice(t("plugins.settingsLinkUnavailable"));
                return;
              }
              if (error.message === "PLUGIN_SETTINGS_HOST_UPDATE_REQUIRED") {
                setFailed(false);
                setLocalError({
                  title: t("plugins.notice.title.authorization"),
                  detail: t("plugins.settingsHostUpdateRequired"),
                });
                return;
              }
              if (
                context === "operation" &&
                error instanceof Error &&
                authorizationFailure.current === error.message
              ) {
                authorizationFailure.current = undefined;
                if (error.message === "PLUGIN_SETTINGS_AUTHORIZATION_CANCELLED")
                  return;
                if (
                  reportedToPage &&
                  error.message !== "PLUGIN_OAUTH_UPDATE_REQUIRED"
                )
                  return;
                setFailed(false);
                setLocalError({
                  title: t("plugins.notice.title.authorization"),
                  detail: t(
                    error.message === "PLUGIN_OAUTH_UPDATE_REQUIRED"
                      ? "plugins.oauthUpdateRequired"
                      : [
                            "PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK",
                            "PLUGIN_OAUTH_CALLBACK_UNSUPPORTED",
                          ].includes(error.message)
                        ? "plugins.computerAuthorizationHint"
                        : "plugins.authorizationCheckHint",
                  ),
                });
                return;
              }
              authorizationFailure.current = undefined;
              // The original form receives command failures; only bridge-only failures need native recovery UI.
              if (reportedToPage) return;
              setFailed(true);
              if (context === "load") setCardUnavailable(true);
              setLocalError({
                title: t(
                  "plugins.notice.title." +
                    (context === "unknown"
                      ? "resultUnknown"
                      : context === "operation"
                        ? "writeFailed"
                        : "readFailed"),
                ),
                detail: t(
                  context === "unknown"
                    ? "plugins.management.settingsResultUnknown"
                    : context === "operation"
                      ? "plugins.management.settingsOperationFailed"
                      : "plugins.management.settingsUnavailable",
                ),
              });
            }}
            onConfirm={(request) => {
              assertCurrent();
              return confirm(
                request.title,
                request.body,
                request.confirmText ?? t("plugins.management.allow"),
                request.cancelText ?? t("plugins.cancel"),
                request.danger,
                request.expiresAt,
              );
            }}
            onDirectory={(request) =>
              new Promise((resolve) => {
                assertCurrent();
                let settled = false;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const finish = (path: string | null) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  pending.current.delete(cancel);
                  if (alive.current) setDirectory(undefined);
                  try {
                    assertCurrent();
                    resolve(Date.now() < request.expiresAt ? path : null);
                  } catch {
                    resolve(null);
                  }
                };
                const cancel = () => finish(null);
                pending.current.add(cancel);
                timer = setTimeout(
                  cancel,
                  Math.max(0, request.expiresAt - Date.now()),
                );
                setDirectory({ request, resolve: finish });
              })
            }
          />
        </View>
        {loading ? (
          <ActivityIndicator
            testID="plugins.settingsLoading"
            color={colors.textSecondary}
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
            }}
          />
        ) : null}
      </View>
      {directory ? (
        <PluginDirectoryPicker
          key={directory.request.id}
          request={directory.request}
          deviceId={captured.deviceId}
          onAnswer={async (path) => directory.resolve(path)}
        />
      ) : null}
    </View>
  );
}
