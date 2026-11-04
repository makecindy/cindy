import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { RemoteDesktopVideoSettings } from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { NativeSwitch } from "@/platform/chrome/NativeSwitch";
import {
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { RemoteDesktopDisplaySettings } from "./RemoteDesktopDisplaySettings";

/**
 * Settings for a device screen (a simulator filling the phone), kept apart
 * from the computer's: whether it stays in a small window after going back,
 * and how smooth and sharp the picture is. Nothing about the computer's
 * display, sound or locking applies here.
 */
export function LiveScreenSettings({
  background,
  video,
  connected,
  controlling,
}: {
  /** Keep showing the device in a small window after going back. */
  background: { enabled: boolean; available: boolean; onChange(): void };
  video: {
    supported: boolean;
    settings: RemoteDesktopVideoSettings;
    busy: boolean;
    notice: string | null;
    onChange(settings: Partial<RemoteDesktopVideoSettings>): void;
  };
  connected: boolean;
  controlling: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const row = (
    key: string,
    label: string,
    value: boolean,
    disabled: boolean,
    onChange: () => void,
  ) => (
    <View style={styles.row}>
      <Text style={[styles.rowTitle, disabled && styles.disabled]}>
        {label}
      </Text>
      <View style={styles.switch}>
        <NativeSwitch
          seedColor={colors.inputCaret}
          accessibilityLabel={label}
          testID={`liveScreen.${key}`}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
        />
      </View>
    </View>
  );
  return (
    <>
      <View style={styles.section}>
        <View style={styles.group}>
          {row(
            "background",
            t("remoteDesktop.liveScreenBackground"),
            background.enabled,
            !background.available && !background.enabled,
            background.onChange,
          )}
        </View>
        <Text style={styles.hint}>
          {t("remoteDesktop.liveScreenBackgroundHint")}
        </Text>
      </View>
      <RemoteDesktopDisplaySettings
        video={{
          ...video,
          modesSupported: false,
          readModes: async () => [],
          onResolution: async () => {},
        }}
        connected={connected}
        controlling={controlling}
      />
      {video.notice && <Text style={styles.hint}>{video.notice}</Text>}
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    section: { gap: spacing.sm },
    group: {
      backgroundColor: colors.surfaceTranslucent,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.sheetActionBorder,
      overflow: "hidden",
    },
    row: {
      minHeight: 58,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    rowTitle: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
    },
    switch: {
      width: 56,
      minHeight: 44,
      alignItems: "flex-end",
      justifyContent: "center",
    },
    hint: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.xs,
    },
    disabled: { opacity: 0.4 },
  });
