import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  type PluginPageConfirm,
  type PluginPagePoll,
} from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
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
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { invokePlugin } from "./pluginClient";

interface Action {
  id: string;
  label: string;
  prompt?: string;
  url?: string;
  disabled: boolean;
}
function parse(
  value: unknown,
): { pluginId: string; revision: string; items: Action[] } | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.pluginId !== "string" ||
    typeof data.revision !== "string" ||
    !Array.isArray(data.items) ||
    data.items.length > 64
  )
    return null;
  const items = data.items.filter(
    (item): item is Action =>
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.label === "string" &&
      item.label.length <= 2048 &&
      typeof item.disabled === "boolean" &&
      (item.prompt === undefined || typeof item.prompt === "string") &&
      (item.url === undefined || typeof item.url === "string"),
  );
  return { pluginId: data.pluginId, revision: data.revision, items };
}
export function PluginCardActions({
  data,
  deviceId,
  sessionId,
  callId,
}: {
  data: unknown;
  deviceId?: string;
  sessionId: string;
  callId: string;
}) {
  const parsed = parse(data);
  return parsed && deviceId ? (
    <CardControls
      key={`${deviceId}:${sessionId}:${callId}:${parsed.pluginId}`}
      {...parsed}
      deviceId={deviceId}
      sessionId={sessionId}
      callId={callId}
    />
  ) : null;
}
function CardControls({
  pluginId,
  revision,
  items,
  deviceId,
  sessionId,
  callId,
}: {
  pluginId: string;
  revision: string;
  items: Action[];
  deviceId: string;
  sessionId: string;
  callId: string;
}) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { invoke, status } = useDeviceLink();
  const focused = useIsFocused(),
    focusedRef = useRef(focused);
  focusedRef.current = focused;
  const lifetime = useRef({ active: true, owner: getMobileAuthOwner() });
  const sending = useRef(false);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const page = useRef<string | undefined>(undefined);
  const [lease, setLease] = useState<string>();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [prompt, setPrompt] = useState<Action>();
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<PluginPageConfirm>();
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [answering, setAnswering] = useState(false);
  const current = () =>
    lifetime.current.active && isMobileAuthOwnerCurrent(lifetime.current.owner);
  useEffect(() => {
    sending.current = false;
    setBusy(false);
    setUnknown(false);
  }, [revision]);
  useEffect(() => {
    const token = { active: true, owner: getMobileAuthOwner() };
    lifetime.current = token;
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      setConfirm(undefined);
    });
    return () => {
      token.active = false;
      listener.remove();
      if (page.current && isMobileAuthOwnerCurrent(lifetime.current.owner))
        void invokePlugin(invoke, deviceId, pluginId, "close", {
          pageId: page.current,
        }).catch(() => {});
    };
  }, [invoke, deviceId, pluginId]);
  useEffect(() => {
    if (!lease) return;
    if (!focused || !foreground || status !== "online") {
      if (current() && status === "online")
        void invokePlugin(invoke, deviceId, pluginId, "suspend", {
          pageId: lease,
        }).catch(() => {});
      return;
    }
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed || !current()) return;
      try {
        const result = await invokePlugin<PluginPagePoll>(
          invoke,
          deviceId,
          pluginId,
          "poll",
          { pageId: lease, after: 0 },
        );
        if (!disposed && current()) setConfirm(result.confirms[0]);
      } catch {
        if (!disposed && current()) {
          setUnknown(true);
          setConfirm(undefined);
        }
      }
      if (!disposed && current()) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [lease, focused, foreground, status, invoke, deviceId, pluginId]);
  const submit = async (action: Action, text?: string) => {
    if (
      sending.current ||
      busy ||
      unknown ||
      action.disabled ||
      status !== "online" ||
      !focusedRef.current ||
      AppState.currentState !== "active"
    )
      return;
    const token = lifetime.current,
      expectedRevision = revision;
    const valid = () =>
      token.active &&
      lifetime.current === token &&
      isMobileAuthOwnerCurrent(token.owner);
    sending.current = true;
    setBusy(true);
    try {
      if (!page.current) {
        const opened = await invokePlugin<{ pageId: string }>(
          invoke,
          deviceId,
          pluginId,
          "open-interaction",
        );
        if (!valid()) {
          if (isMobileAuthOwnerCurrent(token.owner))
            void invokePlugin(
              invoke,
              deviceId,
              pluginId,
              "close",
              opened,
            ).catch(() => {});
          return;
        }
        page.current = opened.pageId;
        setLease(opened.pageId);
      }
      await invoke(
        deviceId,
        REMOTE_RESOURCE_INVOKE_CHANNEL,
        [
          {
            client: { protocolVersion: 1, primitives: ["plugin-card-actions"] },
            collectionId: "plugin-results",
            resourceRef: {
              collectionId: "plugin-results",
              kind: "card",
              id: JSON.stringify([sessionId, callId]),
            },
            actionId: action.id,
            input: {
              revision,
              pageId: page.current,
              ...(text !== undefined ? { prompt: text } : {}),
            },
          },
        ],
        {
          preSend: () => {
            if (
              !valid() ||
              !focusedRef.current ||
              AppState.currentState !== "active" ||
              revisionRef.current !== expectedRevision
            )
              throw new Error("PLUGIN_PAGE_CLOSED");
          },
        },
      );
      if (valid() && revisionRef.current === expectedRevision) {
        setPrompt(undefined);
        setDraft("");
        sending.current = false;
        setBusy(false);
      }
      // A known delivery permits a new deliberate click, never an automatic replay.
    } catch {
      if (valid() && revisionRef.current === expectedRevision) setUnknown(true);
    }
  };
  const choose = (action: Action) => {
    if (action.url) {
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(url.protocol)) return;
      Alert.alert(t("plugins.externalTitle"), url.href, [
        { text: t("plugins.cancel"), style: "cancel" },
        {
          text: t("plugins.open"),
          onPress: () => {
            void Linking.openURL(url.href).catch(() => setUnknown(true));
          },
        },
      ]);
    } else if (action.prompt !== undefined) {
      setPrompt(action);
      setDraft("");
    } else void submit(action);
  };
  const answer = async (confirmed: boolean) => {
    if (!confirm || answering) return;
    setAnswering(true);
    try {
      await invokePlugin(invoke, deviceId, pluginId, "answer", {
        pageId: page.current,
        confirmId: confirm.id,
        confirmed,
      });
      if (current()) setConfirm(undefined);
    } catch {
      if (current()) {
        setUnknown(true);
        setConfirm(undefined);
      }
    } finally {
      if (current()) setAnswering(false);
    }
  };
  return (
    <View style={styles.root}>
      <View style={styles.actions}>
        {items.map((action) => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            disabled={action.disabled || busy || unknown || status !== "online"}
            style={styles.button}
            onPress={() => choose(action)}
          >
            <Text style={styles.label}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
      {unknown ? (
        <Text style={styles.note}>{t("plugins.pageUnconfirmed")}</Text>
      ) : null}
      <Modal
        visible={Boolean(focused && foreground && (prompt || confirm))}
        transparent
        onRequestClose={() => {
          if (confirm) void answer(false);
          else setPrompt(undefined);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.scrim}
        >
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.title}>{confirm?.title ?? prompt?.label}</Text>
            {confirm ? (
              <Text style={styles.body}>{confirm.body}</Text>
            ) : (
              <TextInput
                autoFocus
                multiline
                value={draft}
                onChangeText={setDraft}
                maxLength={2000}
                placeholder={prompt?.prompt}
                style={styles.input}
              />
            )}
            <View style={styles.actions}>
              <Pressable
                style={styles.button}
                disabled={answering}
                onPress={() => {
                  if (confirm) void answer(false);
                  else setPrompt(undefined);
                }}
              >
                <Text style={styles.label}>
                  {confirm?.cancelText ?? t("plugins.cancel")}
                </Text>
              </Pressable>
              <Pressable
                style={styles.button}
                disabled={
                  answering || (!confirm && (!draft.trim() || busy || unknown))
                }
                onPress={() => {
                  if (confirm) void answer(true);
                  else if (prompt) void submit(prompt, draft.trim());
                }}
              >
                <Text style={[styles.label, confirm?.danger && styles.danger]}>
                  {confirm?.confirmText ?? t("plugins.confirm")}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { gap: spacing.sm },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    button: {
      minHeight: 44,
      padding: spacing.md,
      borderRadius: radius.pill,
      justifyContent: "center",
      backgroundColor: c.surfaceChip,
    },
    label: {
      color: c.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    note: {
      color: c.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    body: {
      color: c.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
    },
    title: {
      color: c.textPrimary,
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
    },
    input: {
      color: c.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      minHeight: 100,
      padding: spacing.md,
      borderRadius: radius.control,
      backgroundColor: c.surface,
    },
    danger: { color: c.destructive },
    scrim: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.lg,
      backgroundColor: c.overlay,
    },
    dialog: {
      backgroundColor: c.surfaceElevated,
      padding: spacing.lg,
      gap: spacing.md,
      borderRadius: radius.container,
      width: "100%",
      maxWidth: 420,
    },
  });
