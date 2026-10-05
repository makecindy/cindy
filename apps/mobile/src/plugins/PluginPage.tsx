import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { useIsFocused } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import type {
  PluginPageAsset,
  PluginPageConfirm,
  PluginPageDocument,
  PluginPagePoll,
  PluginPageSurface,
  PluginDirectoryRequest,
  PluginNativeIntent as NativeIntent,
  PluginPageFetchResult,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { invokePlugin, loadPluginPageAssets } from "./pluginClient";
import { PluginNativeIntent } from "./PluginNativeIntent";
import { PluginDirectoryPicker } from "./PluginDirectoryPicker";
import { pluginPageHtml } from "./pluginPageHtml";

function pageColors(colors: ThemeColors) {
  return {
    background: colors.surface,
    surface: colors.surface,
    "surface-elevated": colors.surfaceElevated,
    "surface-chip": colors.surfaceChip,
    "text-primary": colors.textPrimary,
    "text-secondary": colors.textSecondary,
    "text-tertiary": colors.textTertiary,
    "text-placeholder": colors.textPlaceholder,
    border: colors.border,
    "border-strong": colors.borderStrong,
    "status-error": colors.statusError,
    "status-done": colors.statusDone,
  };
}

export function PluginPage({
  deviceId,
  pluginId,
  surface,
  onTask,
  visible = true,
  registerBack,
  onTitle,
}: {
  deviceId: string;
  pluginId: string;
  surface: PluginPageSurface;
  visible?: boolean;
  registerBack?(handler: (() => void) | null): void;
  onTitle?(title: string): void;
  onTask(id: string): void;
}) {
  const { t } = useTranslation();
  const { invoke, status } = useDeviceLink();
  const { mode, colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const routeFocused = useIsFocused(),
    focused = routeFocused && visible;
  const webview = useRef<WebView>(null);
  const draftOwner = useRef(getMobileAuthOwner()).current;
  const draftQueue = useRef(Promise.resolve());
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<{
    document: PluginPageDocument;
    assets: Record<string, PluginPageAsset>;
  }>();
  const [error, setError] = useState(false);
  const [nativeIntent, setNativeIntent] = useState<NativeIntent>();
  const taskIntent = useRef<string | undefined>(undefined);
  const [directoryRequest, setDirectoryRequest] =
    useState<PluginDirectoryRequest>();
  const [confirm, setConfirm] = useState<PluginPageConfirm>();
  const [answering, setAnswering] = useState(false);
  const [notice, setNotice] = useState("");
  const focusedRef = useRef(focused);
  const delivery = useRef(0);
  focusedRef.current = focused;
  const send = useCallback(
    (value: unknown) =>
      webview.current?.postMessage(
        JSON.stringify({
          ...(value as Record<string, unknown>),
          deliveryId: ++delivery.current,
        }),
      ),
    [],
  );
  const request = useRef<
    (<T>(action: string, input?: Record<string, unknown>) => Promise<T>) | null
  >(null);
  const documentRef = useRef<PluginPageDocument | undefined>(undefined);
  const cursor = useRef(0),
    rendered = useRef(false);

  useEffect(() => {
    const owner = getMobileAuthOwner();
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let page: PluginPageDocument | undefined,
      polling = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const visible = () =>
      current() && focusedRef.current && AppState.currentState === "active";
    const call = <T,>(action: string, input: Record<string, unknown> = {}) =>
      invokePlugin<T>(
        (device, channel, args) =>
          invoke(device, channel, args, {
            preSend: () => {
              if (
                !current() ||
                ([
                  "post",
                  "fetch",
                  "media:open",
                  "answer",
                  "answer-directory",
                  "intent:ack",
                  "preview:fetch",
                  "seen",
                ].includes(action) &&
                  !visible())
              )
                throw new Error("PLUGIN_PAGE_CLOSED");
            },
          }),
        deviceId,
        pluginId,
        action,
        { ...input, ...(page ? { pageId: page.pageId } : {}) },
      );
    request.current = call;
    documentRef.current = undefined;
    cursor.current = 0;
    rendered.current = false;
    setContent(undefined);
    setError(false);
    setConfirm(undefined);
    setDirectoryRequest(undefined);
    setNativeIntent(undefined);
    const poll = async () => {
      if (!visible() || !page || !rendered.current || polling) return;
      polling = true;
      try {
        const result = await call<PluginPagePoll>("poll", {
          after: cursor.current,
        });
        if (!visible()) return;
        if (
          !result ||
          !Array.isArray(result.events) ||
          !Array.isArray(result.confirms)
        )
          throw new Error("PLUGIN_PAGE_INVALID");
        send({
          type: "events",
          events: result.events,
          unreadAt: result.unreadAt,
        });
        setConfirm(result.confirms[0]);
        setDirectoryRequest(result.directories?.[0]);
        setNativeIntent(result.intents?.[0]);
        if (result.notifications?.length)
          setNotice(result.notifications.at(-1)!.text);
        setError(false);
      } catch {
        if (current()) setError(true);
      } finally {
        polling = false;
        if (visible()) timer = setTimeout(() => void poll(), 1_000);
      }
    };
    void (async () => {
      try {
        page = await call<PluginPageDocument>(`open:${surface}`);
        if (!current()) return;
        const assets = await loadPluginPageAssets(
          page,
          (path, offset) => call("asset", { path, offset }),
          current,
        );
        if (!current()) return;
        documentRef.current = page;
        setContent({ document: page, assets });
        // Polling starts only after ready, so startup events cannot disappear before the WebView mounts.
      } catch {
        if (current()) setError(true);
      } finally {
        if (!current() && page && isMobileAuthOwnerCurrent(owner))
          void invokePlugin(invoke, deviceId, pluginId, "close", {
            pageId: page.pageId,
          }).catch(() => {});
      }
    })();
    const ready = () => {
      if (timer) clearTimeout(timer);
      void poll();
    };
    startPolling.current = ready;
    const foreground = AppState.addEventListener("change", (state) => {
      send({
        type: "lifecycle",
        active: state === "active" && focusedRef.current,
      });
      if (timer) clearTimeout(timer);
      if (state === "active" && documentRef.current) ready();
      else {
        setConfirm(undefined);
        setDirectoryRequest(undefined);
        setNativeIntent(undefined);
        if (page) void call("suspend").catch(() => {});
      }
    });
    return () => {
      disposed = true;
      request.current = null;
      startPolling.current = null;
      if (timer) clearTimeout(timer);
      foreground.remove();
      if (page && isMobileAuthOwnerCurrent(owner))
        void invokePlugin(invoke, deviceId, pluginId, "close", {
          pageId: page.pageId,
        }).catch(() => {});
    };
  }, [deviceId, pluginId, surface, attempt, invoke, send]);
  const startPolling = useRef<(() => void) | null>(null);
  useEffect(() => {
    send({
      type: "lifecycle",
      active: focused && AppState.currentState === "active",
    });
    if (focused) startPolling.current?.();
    else {
      setConfirm(undefined);
      setDirectoryRequest(undefined);
      setNativeIntent(undefined);
      if (documentRef.current)
        void request.current?.("suspend").catch(() => {});
    }
  }, [focused]);
  useEffect(() => () => registerBack?.(null), [registerBack]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const closeIntent = async () => {
    const call = request.current;
    if (!call || !nativeIntent) return false;
    try {
      await call("intent:ack", { intentId: nativeIntent.id });
      if (call !== request.current) return false;
      setNativeIntent(undefined);
      return true;
    } catch {
      if (call === request.current) {
        setNativeIntent(undefined);
        setError(true);
      }
      return false;
    }
  };
  useEffect(() => {
    if (
      nativeIntent?.kind !== "task" ||
      !focused ||
      taskIntent.current === nativeIntent.id
    )
      return;
    taskIntent.current = nativeIntent.id;
    void closeIntent().then((acknowledged) => {
      if (
        acknowledged &&
        focusedRef.current &&
        isMobileAuthOwnerCurrent(draftOwner)
      )
        onTask(nativeIntent.taskId);
    });
  }, [nativeIntent?.id, focused]);
  useEffect(() => {
    const call = request.current;
    if (
      !call ||
      !focused ||
      !documentRef.current ||
      AppState.currentState !== "active"
    )
      return;
    const hidden = !!nativeIntent && nativeIntent.kind !== "task";
    send({ type: "lifecycle", active: !hidden });
    void call("cover", { hidden }).catch(() => {
      if (request.current === call) setError(true);
    });
  }, [nativeIntent?.id, focused]);
  const appearance = useRef({ mode, colors });
  appearance.current = { mode, colors };
  const html = useMemo(
    () =>
      content
        ? pluginPageHtml({
            ...content,
            theme: appearance.current.mode,
            colors: pageColors(appearance.current.colors),
          })
        : "",
    [content],
  );
  useEffect(
    () =>
      send({
        type: "theme",
        theme: mode,
        colors: pageColors(colors),
      }),
    [send, mode, colors],
  );
  const answer = async (confirmed: boolean) => {
    if (!confirm || answering || !request.current) return;
    const call = request.current;
    setAnswering(true);
    try {
      await call("answer", { confirmId: confirm.id, confirmed });
      if (request.current === call) setConfirm(undefined);
    } catch {
      if (request.current === call) {
        setError(true);
        setConfirm(undefined);
      }
    } finally {
      if (request.current === call) setAnswering(false);
    }
  };
  const onMessage = async (event: WebViewMessageEvent) => {
    if (!request.current || !isMobileAuthOwnerCurrent(draftOwner)) return;
    let message: Record<string, unknown>;
    try {
      if (event.nativeEvent.data.length > 65_536) return;
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    const call = request.current,
      pageId = documentRef.current?.pageId;
    if (
      !message ||
      typeof message !== "object" ||
      !pageId ||
      message.pageId !== pageId
    )
      return;
    const current = () =>
      request.current === call && documentRef.current?.pageId === pageId;
    const reply = (value: unknown) => {
      if (current()) send(value);
    };
    try {
      if (message.type === "draft:get" || message.type === "draft:set") {
        if (
          typeof message.id !== "string" ||
          message.id.length > 64 ||
          typeof message.key !== "string" ||
          !/^[a-zA-Z0-9._-]{1,64}$/.test(message.key)
        )
          return;
        const key = `cindy.pluginDraft.v1.${JSON.stringify([draftOwner.accountKey, deviceId, pluginId, surface, message.key])}`;
        const operation = draftQueue.current.then(async () => {
          if (!current() || !isMobileAuthOwnerCurrent(draftOwner))
            throw new Error("PLUGIN_PAGE_CLOSED");
          if (message.type === "draft:set") {
            const json = JSON.stringify(message.value);
            if (typeof json !== "string" || json.length > 48 * 1024)
              throw new Error("PLUGIN_DRAFT_TOO_LARGE");
            await AsyncStorage.setItem(key, json);
            return null;
          }
          const json = await AsyncStorage.getItem(key);
          if (!isMobileAuthOwnerCurrent(draftOwner))
            throw new Error("PLUGIN_PAGE_CLOSED");
          return json ? JSON.parse(json) : null;
        });
        draftQueue.current = operation.then(
          () => {},
          () => {},
        );
        try {
          reply({
            type: "draft:reply",
            id: message.id,
            value: await operation,
          });
        } catch {
          reply({ type: "draft:reply", id: message.id, error: true });
        }
        return;
      }
      if (
        !focusedRef.current ||
        AppState.currentState !== "active" ||
        (nativeIntent && ["post", "link"].includes(String(message.type)))
      )
        return;
      if (
        message.type === "navigation" &&
        typeof message.canGoBack === "boolean"
      ) {
        registerBack?.(
          message.canGoBack
            ? () => {
                if (current()) send({ type: "back" });
              }
            : null,
        );
        if (
          typeof message.title === "string" &&
          message.title.trim().length <= 40 &&
          !/[\x00-\x1f]/.test(message.title)
        )
          onTitle?.(message.title.trim());
      } else if (message.type === "resource-error") {
        setError(true);
      } else if (message.type === "ready") {
        rendered.current = true;
        send({
          type: "lifecycle",
          active: focusedRef.current && AppState.currentState === "active",
        });
        startPolling.current?.();
      } else if (
        message.type === "content-rendered" &&
        documentRef.current?.surface === "panel" &&
        rendered.current &&
        Number.isSafeInteger(message.seenAt)
      ) {
        // An older frame acknowledgement must not clear a newer mark.
        await call("seen", { seenAt: message.seenAt }).catch(() => {});
      } else if (
        message.type === "events-ack" &&
        message.pageId === documentRef.current?.pageId &&
        Number.isSafeInteger(message.sequence)
      ) {
        cursor.current = Math.max(cursor.current, message.sequence as number);
      } else if (
        message.type === "post" &&
        typeof message.channel === "string"
      ) {
        await call("post", { channel: message.channel, data: message.data });
      } else if (message.type === "fetch" && typeof message.id === "string") {
        try {
          reply({
            type: "reply",
            id: message.id,
            result: await call("fetch", {
              path: message.path,
              method: message.method,
              body: message.body,
              offset: message.offset,
              revision: message.revision,
            }),
          });
        } catch {
          reply({ type: "reply", id: message.id, error: true });
        }
      } else if (message.type === "link" && typeof message.url === "string") {
        let url: URL;
        try {
          url = new URL(
            message.url,
            `cindy-ghost://${pluginId}/${documentRef.current?.entry ?? ""}`,
          );
        } catch {
          return;
        }
        if (
          url.protocol === "cindy-ghost:" &&
          url.hostname === pluginId &&
          url.pathname.startsWith("/preview/")
        ) {
          await call("media:open", { url: url.href });
          return;
        }
        if (url.protocol === "https:")
          Alert.alert(t("plugins.externalTitle"), url.href, [
            { text: t("plugins.cancel"), style: "cancel" },
            {
              text: t("plugins.open"),
              onPress: () => {
                if (!current()) return;
                void Linking.openURL(url.href).catch(() => setError(true));
              },
            },
          ]);
        else if (
          url.protocol === "cindy:" &&
          url.hostname === "sessions" &&
          /^\/[a-zA-Z0-9-]+$/.test(url.pathname)
        ) {
          const id = url.pathname.slice(1);
          Alert.alert(t("plugins.openTask"), undefined, [
            { text: t("plugins.cancel"), style: "cancel" },
            {
              text: t("plugins.open"),
              onPress: () => {
                if (current()) onTask(id);
              },
            },
          ]);
        }
      }
    } catch {
      if (current()) setError(true);
    }
  };
  const unavailable = error || status !== "online";
  return (
    <View style={styles.root}>
      {unavailable ? (
        <View style={styles.banner}>
          <Text style={styles.note}>{t("plugins.pageUnconfirmed")}</Text>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => setAttempt((n) => n + 1)}
          >
            <Text style={styles.buttonText}>{t("plugins.reopen")}</Text>
          </Pressable>
        </View>
      ) : null}
      {html ? (
        <View
          style={styles.root}
          pointerEvents={unavailable || !!nativeIntent ? "none" : "auto"}
        >
          <WebView
            ref={webview}
            source={{ html }}
            style={styles.webview}
            originWhitelist={["*"]}
            incognito
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically={false}
            allowsInlineMediaPlayback
            onShouldStartLoadWithRequest={(request) =>
              request.url === "about:blank"
            }
            onMessage={(event) => {
              void onMessage(event);
            }}
            onError={() => setError(true)}
            onContentProcessDidTerminate={() => setError(true)}
          />
        </View>
      ) : !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.note}>{t("plugins.loadingPage")}</Text>
        </View>
      ) : null}
      {notice ? (
        <View accessibilityLiveRegion="polite" style={styles.banner}>
          <Text style={styles.note}>{notice}</Text>
        </View>
      ) : null}
      {nativeIntent &&
      nativeIntent.kind !== "task" &&
      focused &&
      !unavailable ? (
        <PluginNativeIntent
          key={nativeIntent.id}
          intent={nativeIntent}
          deviceId={deviceId}
          onClose={() => void closeIntent()}
          readMedia={async (path, offset) => {
            const call = request.current;
            if (
              !call ||
              !focusedRef.current ||
              AppState.currentState !== "active"
            )
              throw new Error("PLUGIN_PAGE_CLOSED");
            return call<PluginPageFetchResult>("fetch", {
              path,
              offset,
              method: "GET",
            });
          }}
          readPreview={(url, offset, revision) => {
            const call = request.current;
            if (!call || !focusedRef.current)
              return Promise.reject(new Error("PLUGIN_PAGE_CLOSED"));
            return call<PluginPageFetchResult>("preview:fetch", {
              intentId: nativeIntent.id,
              url,
              offset,
              ...(revision ? { revision } : {}),
            });
          }}
        />
      ) : null}
      {directoryRequest && focused && !unavailable ? (
        <PluginDirectoryPicker
          key={directoryRequest.id}
          request={directoryRequest}
          deviceId={deviceId}
          onAnswer={async (path) => {
            const call = request.current;
            if (
              !call ||
              !focusedRef.current ||
              AppState.currentState !== "active"
            )
              return;
            try {
              await call("answer-directory", {
                requestId: directoryRequest.id,
                path,
              });
              if (request.current === call) setDirectoryRequest(undefined);
            } catch {
              if (request.current === call) {
                setDirectoryRequest(undefined);
                setError(true);
              }
              throw new Error("PLUGIN_PAGE_UNCONFIRMED");
            }
          }}
        />
      ) : null}
      <Modal
        visible={Boolean(
          confirm &&
          !directoryRequest &&
          !nativeIntent &&
          focused &&
          !unavailable,
        )}
        transparent
        animationType="fade"
        onRequestClose={() => {
          void answer(false);
        }}
      >
        <View style={styles.scrim}>
          <View accessibilityViewIsModal style={styles.dialog}>
            <Text style={styles.title}>{confirm?.title}</Text>
            <Text style={styles.body}>{confirm?.body}</Text>
            <View style={styles.actions}>
              <Pressable
                disabled={answering}
                style={styles.button}
                onPress={() => {
                  void answer(false);
                }}
              >
                <Text style={styles.buttonText}>
                  {confirm?.cancelText ?? t("plugins.cancel")}
                </Text>
              </Pressable>
              <Pressable
                disabled={answering}
                style={[styles.button, !confirm?.danger && styles.primary]}
                onPress={() => {
                  void answer(true);
                }}
              >
                <Text
                  style={
                    confirm?.danger ? styles.destructive : styles.primaryText
                  }
                >
                  {confirm?.confirmText ?? t("plugins.confirm")}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.surface },
    webview: { flex: 1, backgroundColor: c.surface },
    loading: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.md,
    },
    banner: {
      padding: spacing.md,
      gap: spacing.sm,
      backgroundColor: c.surface,
    },
    note: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textSecondary,
    },
    body: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: c.textSecondary,
    },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    button: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    primaryText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: c.ctaText,
    },
    destructive: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: c.destructive,
    },
    primary: { backgroundColor: c.textPrimary },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: spacing.sm,
    },
    scrim: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.lg,
      backgroundColor: c.overlay,
    },
    dialog: {
      backgroundColor: c.surfaceElevated,
      borderRadius: radius.container,
      padding: spacing.lg,
      gap: spacing.md,
      width: "100%",
      maxWidth: 420,
    },
  });
