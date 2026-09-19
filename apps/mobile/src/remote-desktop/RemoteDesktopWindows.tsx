import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  RemoteDesktopRequest,
  RemoteDesktopWindow,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { radius, spacing, typeScale, useTheme } from "@/theme";
import { RemoteDesktopPanel } from "./RemoteDesktopChrome";

export function RemoteDesktopWindows({
  lease,
  request,
  onClose,
  landscape,
  topInset,
  caption,
}: {
  lease: string;
  request<T>(request: RemoteDesktopRequest): Promise<T>;
  onClose(): void;
  landscape: boolean;
  topInset: number;
  caption: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [windows, setWindows] = useState<RemoteDesktopWindow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    alive.current = true;
    setFailed(false);
    setWindows(null);
    void request<RemoteDesktopWindow[]>({
      op: "windowAction",
      action: "list",
      lease,
    })
      .then((items) => {
        if (
          !Array.isArray(items) ||
          items.length > 256 ||
          items.some(
            (item) =>
              !item ||
              typeof item.id !== "string" ||
              !/^0x[a-f0-9]{1,16}$/.test(item.id) ||
              typeof item.title !== "string" ||
              item.title.length > 256 ||
              typeof item.app !== "string" ||
              item.app.length > 128,
          )
        )
          throw new Error("INVALID_RESPONSE");
        if (current) setWindows(items);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [lease, request, retry]);
  const activate = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await request({ op: "windowAction", action: "activate", lease, id });
      if (alive.current) onClose();
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <RemoteDesktopPanel
      landscape={landscape}
      topInset={topInset}
      title={t("remoteDesktop.allWindows")}
      caption={caption}
      onClose={onClose}
    >
      {failed ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setRetry((value) => value + 1)}
          style={{ padding: spacing.md }}
        >
          <Text style={{ color: colors.textPrimary }}>
            {t("remoteDesktop.windowsFailed")}
          </Text>
        </Pressable>
      ) : windows === null ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : windows.length === 0 ? (
        <Text style={{ color: colors.textSecondary }}>
          {t("remoteDesktop.noWindows")}
        </Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {windows.map((window) => (
            <Pressable
              key={window.id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                void activate(window.id);
              }}
              style={{
                minHeight: 56,
                padding: spacing.md,
                borderRadius: radius.control,
                backgroundColor: colors.surfaceElevated,
                gap: spacing.xs,
              }}
            >
              <Text
                numberOfLines={2}
                style={{ fontSize: typeScale.body, color: colors.textPrimary }}
              >
                {window.title || window.app}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: typeScale.caption,
                  color: colors.textSecondary,
                }}
              >
                {window.app}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </RemoteDesktopPanel>
  );
}
