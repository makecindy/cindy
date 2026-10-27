import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View, useWindowDimensions } from "react-native";
import WebView from "react-native-webview";
import {
  parsePluginSettingsRequest,
  type PluginPageConfirm,
  type PluginPagePoll,
  type PluginDirectoryRequest,
  type PluginSettingsCommand,
} from "@cindy/device-link";
import {
  motionDuration,
  motionEasing,
  radius,
  spacing,
  useTheme,
} from "@/theme";
import {
  openPluginSettingsClient,
  type PluginSettingsClient,
  type PluginSettingsClientOptions,
} from "./pluginSettingsClient";
import { preparePluginSettingsResources } from "./pluginSettingsResources";
import { settingsInjection } from "./pluginSettingsHtml";
import { pluginSettingsMediaType } from "./pluginSettingsAssets";

export interface PluginSettingsCardProps extends PluginSettingsClientOptions {
  active: boolean;
  /** Captured owner + connection epoch. Changing it tears down the entire document/lease. */
  generation: string | number;
  onError?(
    error: Error,
    context?: "load" | "read" | "operation" | "unknown",
    reportedToPage?: boolean,
  ): void;
  onOpenLink?(url: string, assertCurrent: () => void): Promise<void>;
  onNotice?(text: string): void;
  onLoading?(loading: boolean): void;
  onConfirm?(request: PluginPageConfirm): Promise<boolean>;
  onDirectory?(request: PluginDirectoryRequest): Promise<string | null>;
}

/** The parent owns the header/banner/native prompts; this card only contains the original settings. */
export function PluginSettingsCard(props: PluginSettingsCardProps) {
  const { colors, mode } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const theme = {
    dark: mode === "dark",
    colors: {
      "panel-bg": colors.surfaceElevated,
      surface: colors.surfaceElevated,
      "surface-elevated": colors.surfaceElevated,
      "surface-chip": colors.surfaceChip,
      "border-default": colors.border,
      "text-primary": colors.textPrimary,
      "text-secondary": colors.textSecondary,
      "text-tertiary": colors.textTertiary,
      "text-placeholder": colors.textPlaceholder,
      "accent-soft": colors.surfaceChip,
      "accent-cta-bg": colors.cta,
      "accent-pure-cta-fg": colors.ctaText,
      "error-bg": colors.surfaceElevated,
      "error-border": colors.errorBorder,
      "error-fg": colors.statusError,
      "focus-ring": colors.inputCaret,
      "msg-scrollbar": colors.border,
      "msg-scrollbar-hover": colors.borderStrong,
      "motion-fast": motionDuration.fast + "ms",
      "motion-spinner-cycle": motionDuration.spinnerCycle + "ms",
      "motion-ease-out": "cubic-bezier(" + motionEasing.out.join(",") + ")",
      "slider-track": colors.surfaceChip,
      "slider-fill": colors.cta,
      "slider-thumb": colors.surfaceElevated,
      "slider-thumb-shadow": "none",
      "msg-tool-card-bg": colors.surfaceElevated,
      "msg-tool-card-border": colors.border,
      "msg-tool-card-text": colors.textPrimary,
      "msg-tool-card-chevron": colors.textSecondary,
      "text-secondary-mid": colors.textSecondary,
      "settings-theme-card-bg": colors.surfaceElevated,
    },
  };
  const latest = useRef(props);
  latest.current = props;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const webview = useRef<WebView>(null);
  const clientRef = useRef<PluginSettingsClient | undefined>(undefined);
  const documentEpoch = useRef(0);
  const documentChannels = useRef<{
    send(command: PluginSettingsCommand, epoch: number): Promise<unknown>;
    reset(): void;
  } | undefined>(undefined);
  const pollRef = useRef<(() => void) | undefined>(undefined);
  const covered = useRef(0);
  const openingLink = useRef<object | null>(null);
  const authorizationActive = useRef<object | null>(null);
  const browserBackground = useRef(false);
  const [resourceEpoch, setResourceEpoch] = useState(0);
  const [authorizing, setAuthorizing] = useState(false);
  const [source, setSource] = useState<{ uri: string }>();
  const [height, setHeight] = useState(160);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const foregroundRef = useRef(foreground);
  foregroundRef.current = foreground;
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active" && authorizationActive.current)
        browserBackground.current = true;
      foregroundRef.current = state === "active";
      setForeground(state === "active");
    });
    return () => listener.remove();
  }, []);
  const { deviceId, instanceId, expectedInstalledApproval } = props.identity;
  const notificationScope = JSON.stringify([
    deviceId,
    instanceId,
    expectedInstalledApproval,
    props.generation,
  ]);
  const deferredNotices = useRef<
    | {
        scope: string;
        notices: PluginPagePoll["notifications"];
      }
    | undefined
  >(undefined);
  useEffect(() => {
    const pending = deferredNotices.current;
    if (!pending) return;
    if (!props.active || pending.scope !== notificationScope) {
      deferredNotices.current = undefined;
      return;
    }
    if (!foreground || authorizing) return;
    deferredNotices.current = undefined;
    try {
      props.assertCurrent();
      for (const notice of pending.notices)
        latest.current.onNotice?.(notice.text);
    } catch {
      /* A replaced owner or connection cannot receive old notices. */
    }
  }, [foreground, authorizing, props.active, notificationScope]);
  const leaseActive = props.active && (foreground || authorizing);
  useEffect(() => {
    if (!leaseActive) {
      setSource(undefined);
      return;
    }
    let disposed = false;
    let client: PluginSettingsClient | undefined;
    let resource:
      Awaited<ReturnType<typeof preparePluginSettingsResources>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    const abort = new AbortController();
    const prompts = new Set<string>();
    let promptQueue = Promise.resolve();
    let channelQueue = Promise.resolve();
    const channels = new Set<string>();
    const check = () => {
      if (
        disposed ||
        !latest.current.active ||
        latest.current.generation !== props.generation ||
        latest.current.identity.deviceId !== deviceId ||
        latest.current.identity.instanceId !== instanceId ||
        latest.current.identity.expectedInstalledApproval !==
          expectedInstalledApproval
      )
        throw new Error("PLUGIN_SETTINGS_CLOSED");
      props.assertCurrent();
    };
    const report = (error: unknown, context: "load" | "read" = "read") => {
      if (!disposed)
        latest.current.onError?.(
          new Error(
            error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
              ? error.message
              : "PLUGIN_SETTINGS_UNAVAILABLE",
          ),
          context,
        );
    };
    const inject = (value: unknown) => {
      check();
      webview.current?.injectJavaScript(
        settingsInjection("__cindySettingsReceive", value),
      );
    };
    const prompt = async (
      request: PluginPageConfirm | PluginDirectoryRequest,
      directory: boolean,
      epoch: number,
    ) => {
      let presented = false;
      try {
        check();
        if (epoch !== documentEpoch.current) return;
        covered.current++;
        presented = true;
        const answer =
          Date.now() >= request.expiresAt
            ? null
            : directory
              ? ((await latest.current.onDirectory?.(
                  request as PluginDirectoryRequest,
                )) ?? null)
              : ((await latest.current.onConfirm?.(
                  request as PluginPageConfirm,
                )) ?? false);
        check();
        if (epoch !== documentEpoch.current || Date.now() >= request.expiresAt) return;
        await client!.send(
          directory
            ? {
                kind: "answer-directory",
                requestId: request.id,
                path: typeof answer === "string" ? answer : null,
              }
            : {
                kind: "confirm",
                requestId: request.id,
                accepted: answer === true,
              },
        );
      } catch (error) {
        if (epoch === documentEpoch.current) report(error);
      } finally {
        if (presented && !disposed)
          covered.current = Math.max(0, covered.current - 1);
      }
    };
    const enqueue = (
      request: PluginPageConfirm | PluginDirectoryRequest,
      directory: boolean,
      epoch: number,
    ) => {
      if (prompts.has(request.id)) return;
      prompts.add(request.id);
      promptQueue = promptQueue.then(() => prompt(request, directory, epoch));
    };
    const poll = async () => {
      const epoch = documentEpoch.current;
      try {
        await channelQueue;
        check();
        if (epoch !== documentEpoch.current) {
          timer = setTimeout(() => void poll(), 800);
          return;
        }
        // Host retains the authorization lease; do not consume notices while the browser owns the UI.
        if (!foregroundRef.current || authorizationActive.current) {
          timer = setTimeout(() => void poll(), 800);
          return;
        }
        const result = (await client!.send({
          kind: "poll",
          after,
        })) as PluginPagePoll;
        check();
        if (
          !result ||
          !Array.isArray(result.events) ||
          !Array.isArray(result.confirms) ||
          !Array.isArray(result.notifications)
        )
          throw new Error("PLUGIN_SETTINGS_INVALID_POLL");
        if (epoch !== documentEpoch.current) {
          for (const event of result.events)
            after = Math.max(after, event.sequence);
          // Host repeats unanswered prompts; remember these even though A is gone.
          for (const request of [...result.confirms, ...(result.directories ?? [])])
            prompts.add(request.id);
        }
        if (!foregroundRef.current || authorizationActive.current) {
          // An in-flight poll has already consumed these notices on Host. Keep them across resource reload.
          deferredNotices.current = {
            scope: notificationScope,
            notices: result.notifications,
          };
          timer = setTimeout(() => void poll(), 800);
          return;
        }
        if (epoch === documentEpoch.current) {
          inject({ kind: "events", events: result.events });
          for (const event of result.events)
            after = Math.max(after, event.sequence);
        }
        for (const notice of result.notifications)
          latest.current.onNotice?.(notice.text);
        for (const confirmation of result.confirms)
          enqueue(confirmation, false, epoch);
        for (const directory of result.directories ?? [])
          enqueue(directory, true, epoch);
        if (!disposed) timer = setTimeout(() => void poll(), 800);
      } catch (error) {
        if (!disposed && epoch !== documentEpoch.current) {
          timer = setTimeout(() => void poll(), 800);
          return;
        }
        report(error);
        if (!disposed) {
          void client?.close().catch(() => {});
          abort.abort();
          setSource(undefined);
        }
      }
    };
    latest.current.onLoading?.(true);
    void (async () => {
      try {
        client = await openPluginSettingsClient({
          ...props,
          assertCurrent: check,
          assertCleanupCurrent:
            props.assertCleanupCurrent ?? props.assertCurrent,
          onAuthorize: async (action) => {
            check();
            if (!latest.current.onAuthorize || authorizationActive.current)
              throw new Error("PLUGIN_SETTINGS_AUTHORIZATION_UNAVAILABLE");
            const token = {};
            authorizationActive.current = token;
            setAuthorizing(true);
            try {
              await latest.current.onAuthorize(action);
              check();
            } finally {
              if (authorizationActive.current === token) {
                authorizationActive.current = null;
                if (!disposed) setAuthorizing(false);
              }
            }
          },
        });
        check();
        clientRef.current = client;
        documentChannels.current = {
          send(command, epoch) {
            if (command.kind === "fetch") {
              // Wait for document activation, but never let a fetch waiting for a native
              // prompt block navigation from cancelling that same prompt on Host.
              const { path, method, body } = command;
              return channelQueue.then(() => {
                check();
                if (epoch !== documentEpoch.current) throw new Error("PLUGIN_SETTINGS_CLOSED");
                return client!.fetch(path, method, body);
              });
            }
            const work = channelQueue.then(async () => {
              check();
              if (epoch !== documentEpoch.current) throw new Error("PLUGIN_SETTINGS_CLOSED");
              // Track before awaiting: a lost acknowledgement can still have subscribed on Host.
              if (command.kind === "subscribe")
                for (const channel of command.channels) channels.add(channel);
              const result = await client!.send(command);
              if (command.kind === "unsubscribe") channels.delete(command.channel);
              return result;
            });
            channelQueue = work.then(() => {}, () => {});
            return work;
          },
          reset() {
            const epoch = documentEpoch.current;
            // Keep the lease/authorization, but release A's channels before B can subscribe.
            // Host unsubscribe also removes buffered events for those channels.
            channelQueue = channelQueue.then(async () => {
              check();
              if (client!.document.documentIsolation)
                await client!.send({ kind: "document", epoch });
              for (const channel of channels) {
                await client!.send({ kind: "unsubscribe", channel });
                channels.delete(channel);
              }
            });
            void channelQueue.catch((error) => {
              report(error);
              clearTimeout(timer);
              abort.abort();
              void client?.close().catch(() => {});
              if (!disposed) setSource(undefined);
            });
          },
        };
        resource = await preparePluginSettingsResources(
          client,
          themeRef.current,
          abort.signal,
        );
        check();
        setSource({ uri: resource.url });
        pollRef.current = () => {
          pollRef.current = undefined;
          void poll();
        };
      } catch (error) {
        report(error, "load");
        void client?.close().catch(() => {});
        if (!disposed) latest.current.onLoading?.(false);
      }
      // Resource readiness only mounts the WebView; keep loading until its document loads.
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      covered.current = 0;
      openingLink.current = null;
      authorizationActive.current = null;
      browserBackground.current = false;
      setAuthorizing(false);
      pollRef.current = undefined;
      documentChannels.current = undefined;
      if (clientRef.current === client) clientRef.current = undefined;
      void resource?.close().catch(() => {});
      void client?.close().catch(() => {});
      setSource(undefined);
    };
    // Functions are captured by this lease; the owner/connection guard must reject a stale source.
  }, [
    deviceId,
    instanceId,
    expectedInstalledApproval,
    props.generation,
    leaseActive,
    resourceEpoch,
  ]);
  useEffect(() => {
    if (source)
      webview.current?.injectJavaScript(
        settingsInjection("__cindySettingsTheme", theme),
      );
  }, [mode, colors, source]);
  const cardHeight = Math.min(height + spacing.lg * 2, 420, windowHeight * 0.5);
  const viewportHeight = Math.max(0, cardHeight - spacing.lg * 2);
  const scrollable = height > viewportHeight;
  if (!source) return null;
  const navigationClient = clientRef.current;
  const pageCurrent = () => {
    try {
      navigationClient?.assertCurrent();
      return !!navigationClient && navigationClient === clientRef.current;
    } catch {
      return false;
    }
  };
  const openLink = (url: string) => {
    const check = () => {
      navigationClient?.assertCurrent();
      if (
        !navigationClient ||
        navigationClient !== clientRef.current ||
        !latest.current.active ||
        !foregroundRef.current
      )
        throw new Error("PLUGIN_SETTINGS_CLOSED");
    };
    try {
      check();
    } catch {
      return;
    }
    if (covered.current || authorizationActive.current || openingLink.current)
      return;
    const token = {};
    openingLink.current = token;
    covered.current++;
    void (async () => {
      try {
        if (!latest.current.onOpenLink)
          throw new Error("PLUGIN_SETTINGS_LINK_UNAVAILABLE");
        await latest.current.onOpenLink(url, check);
      } catch {
        try {
          check();
          latest.current.onError?.(
            new Error("PLUGIN_SETTINGS_LINK_UNAVAILABLE"),
            "operation",
          );
        } catch {
          /* The initiating page has gone away. */
        }
      } finally {
        if (openingLink.current === token) {
          openingLink.current = null;
          covered.current = Math.max(0, covered.current - 1);
        }
      }
    })();
  };
  const navigate = (raw: string) => {
    try {
      navigationClient?.assertCurrent();
      if (!navigationClient || navigationClient !== clientRef.current)
        return false;
      const url = new URL(raw);
      const bootstrap = new URL(source.uri);
      bootstrap.hash = "";
      const withoutHash = new URL(raw);
      withoutHash.hash = "";
      if (withoutHash.href === bootstrap.href) return true;
      if (url.origin === new URL(source.uri).origin) {
        return navigationClient.document.files.some(
          (file) =>
            pluginSettingsMediaType(file.mime) === "text/html" &&
            file.path === decodeURIComponent(url.pathname.slice(1)),
        );
      }
      openLink(raw);
    } catch {
      /* Untrusted or obsolete navigation stays inside the settings boundary. */
    }
    return false;
  };
  return (
    <View
      style={[
        styles.card,
        {
          height: cardHeight,
          backgroundColor: colors.surfaceElevated,
          borderColor: colors.border,
        },
      ]}
    >
      <WebView
        ref={webview}
        source={{ uri: source.uri }}
        style={{
          height: viewportHeight,
          backgroundColor: colors.surfaceElevated,
        }}
        incognito
        cacheEnabled={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={true}
        mediaPlaybackRequiresUserAction
        allowsInlineMediaPlayback={false}
        scrollEnabled={scrollable}
        indicatorStyle={mode === "dark" ? "white" : "black"}
        nestedScrollEnabled={scrollable}
        // RNW sends whitelist failures to the OS before our navigation callback. Always consume them here.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(request) => navigate(request.url)}
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (navigate(url)) setSource({ uri: url });
        }}
        mediaCapturePermissionGrantType="deny"
        onFileDownload={() =>
          latest.current.onError?.(
            new Error("PLUGIN_SETTINGS_DOWNLOAD_BLOCKED"),
            "operation",
          )
        }
        onLoadStart={() => {
          if (!pageCurrent()) return;
          documentEpoch.current++;
          documentChannels.current?.reset();
          latest.current.onLoading?.(true);
        }}
        onLoad={() => {
          if (!pageCurrent()) return;
          latest.current.onLoading?.(false);
          webview.current?.injectJavaScript(
            settingsInjection("__cindySettingsTheme", themeRef.current),
          );
          pollRef.current?.();
        }}
        onError={() => {
          if (!pageCurrent()) return;
          latest.current.onLoading?.(false);
          latest.current.onError?.(
            new Error("PLUGIN_SETTINGS_UNAVAILABLE"),
            "load",
          );
        }}
        onMessage={(event) => {
          const client = navigationClient;
          if (
            !pageCurrent() ||
            !client ||
            event.nativeEvent.data.length > 150_000
          )
            return;
          const requestDocument = documentEpoch.current;
          try {
            client.assertCurrent();
            const message = JSON.parse(event.nativeEvent.data);
            if (message.settings !== client.document.pageId) return;
            if (Number.isFinite(message.height) && message.id === undefined) {
              setHeight(Math.max(64, Math.min(12_000, message.height)));
              return;
            }
            if (
              !Number.isSafeInteger(message.id) ||
              message.id < 1 ||
              !parsePluginSettingsRequest({
                op: "settings",
                id: message.settings,
                command: message.command,
              })
            )
              return;
            const command = message.command;
            const requestId = message.id;
            const authorization =
              command.kind === "fetch" &&
              command.method === "POST" &&
              /^\/oauth\/[^/]+\/connect$/.test(command.path);
            const work =
              covered.current ||
              !foregroundRef.current ||
              authorizationActive.current
                ? Promise.reject(new Error("PLUGIN_SETTINGS_COVERED"))
                : ["fetch", "subscribe", "unsubscribe", "post"].includes(command.kind)
                  ? documentChannels.current!.send(command, requestDocument)
                  : Promise.reject(
                      new Error("PLUGIN_SETTINGS_COMMAND_BLOCKED"),
                    );
            if (command.kind === "fetch") command.body = undefined;
            void work
              .then((value) => {
                client.assertCurrent();
                // Package navigation keeps the lease but restarts bridge request IDs.
                if (requestDocument !== documentEpoch.current) return;
                webview.current?.injectJavaScript(
                  settingsInjection("__cindySettingsReceive", {
                    kind: "reply",
                    id: requestId,
                    ok: true,
                    value,
                  }),
                );
              })
              .catch((error) => {
                try {
                  client.assertCurrent();
                  if (requestDocument !== documentEpoch.current) return;
                  let reportedToPage = false;
                  const page = webview.current;
                  if (page) {
                    try {
                      page.injectJavaScript(
                        settingsInjection("__cindySettingsReceive", {
                          kind: "reply",
                          id: requestId,
                          ok: false,
                        }),
                      );
                      reportedToPage = true;
                    } catch {
                      /* A live native recovery surface remains available if injection fails. */
                    }
                  }
                  latest.current.onError?.(
                    new Error(
                      error instanceof Error &&
                        /^[A-Z_]{1,80}$/.test(error.message)
                        ? error.message
                        : "PLUGIN_SETTINGS_UNAVAILABLE",
                    ),
                    error &&
                      typeof error === "object" &&
                      error.settingsOutcome === "unknown"
                      ? "unknown"
                      : command.kind === "fetch" && command.method === "GET"
                        ? "read"
                        : "operation",
                    reportedToPage,
                  );
                } catch {
                  /* Stale page cannot receive results. */
                }
              })
              .finally(() => {
                if (!authorization || !browserBackground.current) return;
                try {
                  client.assertCurrent();
                  // Native preview servers stop on background. Reopen from Host facts
                  // after authorization settles, without copying drafts or replaying writes.
                  browserBackground.current = false;
                  setResourceEpoch((value) => value + 1);
                } catch {
                  /* A replaced lease cannot reopen its old page. */
                }
              });
          } catch {
            /* Untrusted page messages never reach a general-purpose invoke. */
          }
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    overflow: "hidden",
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
