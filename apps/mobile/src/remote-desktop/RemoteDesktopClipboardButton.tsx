import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { ClipboardList, Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  NativePullDownMenu,
  usesNativePullDownMenu,
} from "@/platform/chrome/NativePullDownMenu";
import { Text } from "@/components/AppText";
import { useTheme, radius, iconSize, iconStroke, spacing } from "@/theme";

export function RemoteDesktopClipboardButton({
  enabled,
  supported,
  transfer,
}: {
  enabled: boolean;
  supported: boolean;
  transfer(action: "copy" | "paste"): Promise<void>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const loadingVisible = useRef(false);
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [done, setDone] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (loadingTimer.current) clearTimeout(loadingTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(timer);
  }, [done]);
  const run = async (action: string) => {
    if (
      !enabled ||
      pending.current ||
      (action !== "copy" && action !== "paste")
    )
      return;
    if (!supported) {
      Alert.alert(
        t("remoteDesktop.clipboard"),
        t("remoteDesktop.clipboardUpgrade"),
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    setDone(false);
    loadingTimer.current = setTimeout(() => {
      if (!mounted.current || !pending.current) return;
      loadingVisible.current = true;
      setLoading(true);
    }, 400);
    try {
      await transfer(action);
      if (mounted.current) setDone(true);
    } catch (error) {
      if (mounted.current) {
        const message = t(
            error instanceof Error && error.message.includes("CLIPBOARD_UPGRADE")
              ? "remoteDesktop.clipboardUpgrade"
              : error instanceof Error && error.message.includes("CLIPBOARD_UNSUPPORTED")
              ? "remoteDesktop.clipboardUnsupported"
              : error instanceof Error && error.message.includes("CLIPBOARD_EMPTY")
              ? "remoteDesktop.clipboardEmpty"
              : error instanceof Error && error.message.includes("CLIPBOARD_TOO_LONG")
                ? "remoteDesktop.clipboardTooLong"
                : action === "copy"
                  ? "remoteDesktop.clipboardCopyFailed"
                  : "remoteDesktop.clipboardPasteFailed",
          );
        // Keep errors in the same presented modal; presenting Alert during its
        // dismissal can lose the error on iOS.
        if (loadingVisible.current) setFailure(message);
        else Alert.alert(t("remoteDesktop.clipboard"), message);
      }
    } finally {
      pending.current = false;
      if (loadingTimer.current) clearTimeout(loadingTimer.current);
      loadingTimer.current = null;
      loadingVisible.current = false;
      if (mounted.current) {
        setBusy(false);
        setLoading(false);
      }
    }
  };
  const actions = [
    {
      id: "copy",
      title: t("remoteDesktop.copyToPhone"),
      image: "doc.on.doc",
      disabled: !enabled || busy,
    },
    {
      id: "paste",
      title: t("remoteDesktop.pasteFromPhone"),
      image: "doc.on.clipboard",
      disabled: !enabled || busy,
    },
  ];
  return (
    <>
    <NativePullDownMenu
      actions={actions}
      onAction={(action) => {
        void run(action);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("remoteDesktop.clipboard")}
        accessibilityState={{ disabled: !enabled || busy, busy }}
        disabled={!enabled || busy}
        onPress={
          usesNativePullDownMenu()
            ? undefined
            : () =>
                Alert.alert(t("remoteDesktop.clipboard"), undefined, [
                  ...actions.map((action) => ({
                    text: action.title,
                    onPress: () => {
                      void run(action.id);
                    },
                  })),
                  { text: t("remoteDesktop.close"), style: "cancel" },
                ])
        }
        style={({ pressed }) => [
          styles.button,
          {
            borderRadius: radius.pill,
            backgroundColor: pressed ? colors.surfaceChip : "transparent",
            opacity: enabled ? 1 : 0.4,
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.textPrimary} />
        ) : done ? (
          <View accessibilityLabel={t("remoteDesktop.clipboardDone")}>
            <Check size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
          </View>
        ) : (
          <ClipboardList size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
        )}
      </Pressable>
    </NativePullDownMenu>
    <Modal
      transparent
      animationType="none"
      visible={loading || failure !== null}
      onRequestClose={() => { if (!pending.current) setFailure(null); }}
      supportedOrientations={["portrait", "landscape"]}
      statusBarTranslucent
    >
      <View style={[styles.backdrop, { backgroundColor: colors.overlay }]}>
        <View
          accessibilityViewIsModal
          accessibilityLiveRegion="polite"
          accessibilityState={{ busy: loading }}
          style={[styles.loadingCard, {
            backgroundColor: colors.surfaceElevated,
            borderColor: colors.border,
          }]}
        >
          {loading && <ActivityIndicator size="large" color={colors.textPrimary} />}
          <Text style={[styles.loadingText, { color: colors.textPrimary }]}>
            {failure ?? t("remoteDesktop.clipboardTransferring")}
          </Text>
          {failure !== null && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setFailure(null)}
              style={({ pressed }) => [styles.dismiss, {
                backgroundColor: pressed ? colors.surfaceElevated : colors.surfaceChip,
              }]}
            >
              <Text style={{ color: colors.textPrimary }}>{t("remoteDesktop.close")}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
    </>
  );
}
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  loadingCard: {
    width: 280,
    maxWidth: "100%",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
  },
  loadingText: { textAlign: "center" },
  dismiss: {
    alignSelf: "stretch",
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
  },
  button: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
});
