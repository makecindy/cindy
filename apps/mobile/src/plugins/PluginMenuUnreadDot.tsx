import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceManagement } from "@/device-link/useDeviceManagement";
import { useRemoteResourceList } from "@/session/useRemoteResourceList";
import { radius, useTheme } from "@/theme";

/** Reading the directory is not an acknowledgement of any plugin's panel. */
export function PluginMenuUnreadDot({ active }: { active: boolean }) {
  const auth = useAuth(),
    { t } = useTranslation(),
    { colors } = useTheme();
  const devices = useDeviceManagement(auth.apiFetch, active);
  const targets = useMemo(
    () =>
      devices.devices
        .filter(
          (device) =>
            device.remoteControlEnabled &&
            !device.isSelf &&
            !["ios", "android"].includes(device.platform ?? ""),
        )
        .map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.name,
        })),
    [devices.devices],
  );
  const plugins = useRemoteResourceList("plugins", targets, active);
  return plugins.items.some((row) => row.item.display.badges?.length) ? (
    <View
      accessibilityLabel={t("plugins.unread")}
      style={[styles.dot, { backgroundColor: colors.statusDone }]}
    />
  ) : null;
}
const styles = StyleSheet.create({
  dot: { width: 6, height: 6, borderRadius: radius.pill },
});
