import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  desktopPermissionReady,
  type RemoteDesktopPermissions,
  type RemoteDesktopRequest,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import {
  spacing,
  radius,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export function PermissionGuide({
  initial,
  request,
  reconnect,
}: {
  initial?: RemoteDesktopPermissions;
  request<T>(message: RemoteDesktopRequest): Promise<T>;
  reconnect(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [status, setStatus] = useState(initial);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!initial)
      return () => {
        mounted.current = false;
      };
    let busy = false;
    const refresh = async () => {
      if (busy || AppState.currentState !== "active") return;
      busy = true;
      try {
        const next = await request<RemoteDesktopPermissions>({
          op: "permissions",
          action: "check",
        });
        if (mounted.current) {
          setStatus(next);
          setNotice((previous) =>
            previous === "permissionCheckFailed" ? null : previous,
          );
        }
      } catch {
        if (mounted.current) setNotice("permissionCheckFailed");
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [initial, request]);
  const guide = async () => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const next = await request<RemoteDesktopPermissions>({
        op: "permissions",
        action: "guide",
      });
      if (mounted.current) {
        setStatus(next);
        setNotice("permissionGuideOpened");
      }
    } catch {
      if (mounted.current) setNotice("permissionActionFailed");
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const ready =
    status &&
    desktopPermissionReady(status.screenRecording) &&
    desktopPermissionReady(status.accessibility);
  return (
    <View style={styles.panel}>
      <Text style={styles.text}>
        {t(
          ready
            ? "remoteDesktop.permissionsReady"
            : "remoteDesktop.permissionsIntro",
        )}
      </Text>
      {status &&
        (["screenRecording", "accessibility"] as const).map((permission) => (
          <View style={styles.row} key={permission}>
            <Text style={styles.text}>{t(`remoteDesktop.${permission}`)}</Text>
            <Text style={styles.caption}>
              {t(
                desktopPermissionReady(status[permission])
                  ? "remoteDesktop.permissionGranted"
                  : status[permission] === "unknown"
                    ? "remoteDesktop.permissionUnknown"
                    : "remoteDesktop.permissionMissing",
              )}
            </Text>
          </View>
        ))}
      <View style={styles.actions}>
        {status && !ready && (
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => {
              void guide();
            }}
            style={styles.button}
          >
            <Text style={styles.text}>
              {t(
                pending
                  ? "remoteDesktop.permissionChecking"
                  : "remoteDesktop.openGuideOnComputer",
              )}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={reconnect}
          style={styles.button}
        >
          <Text style={styles.text}>
            {t("remoteDesktop.reconnectAfterPermissions")}
          </Text>
        </Pressable>
      </View>
      {notice && (
        <Text accessibilityRole="alert" style={styles.caption}>
          {t(`remoteDesktop.${notice}`)}
        </Text>
      )}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    panel: {
      padding: spacing.md,
      gap: spacing.sm,
      backgroundColor: colors.surface,
    },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.md,
      borderRadius: radius.control,
      backgroundColor: colors.surfaceElevated,
    },
    text: { fontSize: typeScale.body, color: colors.textPrimary },
    caption: { fontSize: typeScale.caption, color: colors.textSecondary },
  });
