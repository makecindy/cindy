import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  RotateCw,
  Volume2,
  PictureInPicture2,
  ChevronLeft,
  LogOut,
  Monitor,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type {
  RemoteDesktopDisplay,
  RemoteDesktopVideoSettings,
  RemoteDesktopDisplayMode,
} from "@cindy/device-link";
import { RemoteDesktopDisplaySettings } from "./RemoteDesktopDisplaySettings";
import { Text } from "@/components/AppText";
import { MainWindowOptionButton } from "@/components/MobilePrimitives";
import { NativeSwitch } from "@/platform/chrome/NativeSwitch";
import {
  fontWeight,
  iconSize,
  iconStroke,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export function RemoteDesktopControls({
  connected,
  controlling,
  controlDisabled,
  inputMode,
  displays,
  displayId,
  onViewOnly,
  onInputMode,
  showMouseButtons,
  onShowMouseButtons,
  onDisplay,
  presentation,
  video,
}: {
  connected: boolean;
  controlling: boolean;
  controlDisabled: boolean;
  inputMode: "touch" | "pointer";
  displays: RemoteDesktopDisplay[];
  displayId?: string;
  onViewOnly(): void;
  onInputMode(mode: "touch" | "pointer"): void;
  showMouseButtons: boolean;
  onShowMouseButtons(value: boolean): void;
  onDisplay(id: string): void;
  presentation: {
    canRotate: boolean;
    canPip: boolean;
    canAudio: boolean;
    onRotate(): void;
    onPip(): void;
  };
  video: {
    supported: boolean;
    settings: RemoteDesktopVideoSettings;
    busy: boolean;
    modesSupported: boolean;
    notice: string | null;
    onChange(settings: RemoteDesktopVideoSettings): void;
    readModes(): Promise<RemoteDesktopDisplayMode[]>;
    onResolution(id: string): Promise<void>;
  };
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [showDisplays, setShowDisplays] = useState(false);
  const [displaySettings, setDisplaySettings] = useState(false);
  const currentDisplay = displays.find((display) => display.id === displayId);
  const canChooseDisplay = connected && displays.length > 1;
  const hint = !controlling ? "viewOnlyHint" : `${inputMode}Hint`;
  const displayLabel = (display: RemoteDesktopDisplay, index: number) =>
    display.name?.trim() ||
    t("remoteDesktop.displayNumber", { number: index + 1 });
  const quickActions: Array<{
    key: string;
    icon: LucideIcon;
    onPress(): void;
    disabled?: boolean;
    selected?: boolean;
  }> = [
    {
      key: "rotate",
      icon: RotateCw,
      onPress: presentation.onRotate,
      disabled: !presentation.canRotate,
    },
    {
      key: "sound",
      icon: Volume2,
      onPress: () =>
        video.onChange({ ...video.settings, audio: !video.settings.audio }),
      disabled: !presentation.canAudio || video.busy || !connected,
      selected: video.settings.audio,
    },
    {
      key: "viewOnly",
      icon: Eye,
      onPress: onViewOnly,
      disabled: controlDisabled,
      selected: connected && !controlling,
    },
    {
      key: "smallWindow",
      icon: PictureInPicture2,
      onPress: presentation.onPip,
      disabled: !presentation.canPip || !connected,
    },
  ];

  return (
    <>
      {!displaySettings && (
        <View style={styles.quickActions}>
          {quickActions.map(
            ({ key, icon: Icon, onPress, disabled, selected }) => (
              <Pressable
                key={key}
                testID={`remoteDesktop.${key}`}
                accessibilityRole="button"
                accessibilityLabel={t(`remoteDesktop.${key}`)}
                accessibilityState={{ disabled, selected }}
                disabled={disabled}
                onPress={onPress}
                style={({ pressed }) => [
                  styles.quickAction,
                  selected && styles.quickSelected,
                  pressed && styles.pressed,
                  disabled && styles.disabled,
                ]}
              >
                <Icon
                  size={iconSize.action}
                  strokeWidth={iconStroke.regular}
                  color={selected ? colors.ctaText : colors.textPrimary}
                />
                <Text
                  style={[
                    styles.quickLabel,
                    selected && styles.quickSelectedLabel,
                  ]}
                >
                  {t(`remoteDesktop.${key}`)}
                </Text>
              </Pressable>
            ),
          )}
        </View>
      )}

      {!displaySettings && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {t("remoteDesktop.inputMode")}
          </Text>
          <View style={styles.segments}>
            {(["touch", "pointer"] as const).map((value) => (
              <MainWindowOptionButton
                key={value}
                label={t(`remoteDesktop.${value}`)}
                testID={`remoteDesktop.${value}`}
                variant="segmented"
                density="default"
                selected={inputMode === value}
                disabled={!connected}
                onPress={() => onInputMode(value)}
                style={styles.segment}
              />
            ))}
          </View>
          <Text style={styles.hint}>{t(`remoteDesktop.${hint}`)}</Text>
          <View style={styles.row}>
            <Text style={[styles.rowTitle, styles.expand]}>
              {t("remoteDesktop.showMouseButtons")}
            </Text>
            <NativeSwitch
              accessibilityLabel={t("remoteDesktop.showMouseButtons")}
              testID="remoteDesktop.showMouseButtons"
              value={showMouseButtons}
              onValueChange={onShowMouseButtons}
            />
          </View>
        </View>
      )}
      {video.notice && (
        <Text style={styles.hint} accessibilityRole="alert">
          {video.notice}
        </Text>
      )}
      {!displaySettings && (
        <Pressable
          onPress={() => setDisplaySettings(true)}
          style={styles.row}
          accessibilityRole="button"
        >
          <Monitor size={iconSize.action} color={colors.textPrimary} />
          <View style={styles.displayText}>
            <Text style={styles.rowTitle}>
              {t("remoteDesktop.displaySettings")}
            </Text>
            {currentDisplay && (
              <Text style={styles.hint}>
                {currentDisplay.width} × {currentDisplay.height}
              </Text>
            )}
          </View>
          <ChevronRight size={iconSize.md} color={colors.textTertiary} />
        </Pressable>
      )}
      {displaySettings && (
        <>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("remoteDesktop.back")}
              onPress={() => setDisplaySettings(false)}
              style={{ padding: spacing.sm }}
            >
              <ChevronLeft size={iconSize.action} color={colors.textPrimary} />
            </Pressable>
            <Text style={styles.rowTitle}>
              {t("remoteDesktop.displaySettings")}
            </Text>
          </View>
          <RemoteDesktopDisplaySettings
            key={displayId}
            video={video}
            connected={connected}
            controlling={controlling}
            displayControl={
              <View>
                {displays.length > 0 && (
                  <>
                    <Pressable
                      testID="remoteDesktop.display"
                      accessibilityRole={canChooseDisplay ? "button" : "text"}
                      accessibilityLabel={t("remoteDesktop.display")}
                      accessibilityState={
                        canChooseDisplay
                          ? { expanded: showDisplays }
                          : undefined
                      }
                      disabled={!canChooseDisplay}
                      onPress={() => setShowDisplays(!showDisplays)}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Monitor
                        size={iconSize.action}
                        color={colors.textPrimary}
                        strokeWidth={iconStroke.regular}
                      />
                      <View style={styles.displayText}>
                        <Text style={styles.rowTitle}>
                          {currentDisplay
                            ? displayLabel(
                                currentDisplay,
                                displays.indexOf(currentDisplay),
                              )
                            : t("remoteDesktop.display")}
                        </Text>
                      </View>
                      {canChooseDisplay &&
                        (showDisplays ? (
                          <ChevronDown
                            size={iconSize.md}
                            color={colors.textTertiary}
                          />
                        ) : (
                          <ChevronRight
                            size={iconSize.md}
                            color={colors.textTertiary}
                          />
                        ))}
                    </Pressable>
                    {canChooseDisplay &&
                      showDisplays &&
                      displays.map((display, index) => (
                        <Pressable
                          key={display.id}
                          testID={`remoteDesktop.display.${display.id}`}
                          accessibilityRole="radio"
                          accessibilityLabel={displayLabel(display, index)}
                          accessibilityState={{
                            checked: display.id === displayId,
                          }}
                          onPress={() => {
                            if (display.id !== displayId) onDisplay(display.id);
                          }}
                          style={({ pressed }) => [
                            styles.displayOption,
                            pressed && styles.pressed,
                          ]}
                        >
                          <View style={styles.displayText}>
                            <Text style={styles.rowTitle}>
                              {displayLabel(display, index)}
                            </Text>
                            <Text style={styles.hint}>
                              {display.width} × {display.height}
                            </Text>
                          </View>
                          {display.id === displayId && (
                            <Check
                              size={iconSize.md}
                              color={colors.textPrimary}
                            />
                          )}
                        </Pressable>
                      ))}
                  </>
                )}
              </View>
            }
          />
        </>
      )}
    </>
  );
}

export function RemoteDesktopDisconnect({ onPress }: { onPress(): void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID="remoteDesktop.disconnect"
      accessibilityRole="button"
      accessibilityLabel={t("remoteDesktop.disconnect")}
      onPress={onPress}
      style={({ pressed }) => [styles.disconnect, pressed && styles.pressed]}
    >
      <LogOut
        size={iconSize.md}
        color={colors.destructive}
        strokeWidth={iconStroke.regular}
      />
      <Text style={styles.disconnectLabel}>
        {t("remoteDesktop.disconnect")}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    quickActions: { flexDirection: "row", gap: spacing.sm },
    quickAction: {
      flex: 1,
      minHeight: 80,
      padding: spacing.sm,
      gap: spacing.sm,
      borderRadius: radius.container,
      backgroundColor: colors.surfaceChip,
      alignItems: "center",
      justifyContent: "center",
    },
    quickSelected: { backgroundColor: colors.cta },
    quickLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      textAlign: "center",
    },
    quickSelectedLabel: { color: colors.ctaText },
    section: { gap: spacing.sm },
    sectionTitle: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
    },
    segments: {
      flexDirection: "row",
      gap: spacing.xs,
      backgroundColor: colors.surfaceChip,
      padding: spacing.xs,
      borderRadius: radius.control,
    },
    segment: { flex: 1, minHeight: 44, borderRadius: radius.control },
    hint: { color: colors.textTertiary, fontSize: typeScale.caption },
    group: {
      backgroundColor: colors.sheetActionSurface,
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
    rowTitle: { color: colors.textPrimary, fontSize: typeScale.body },
    expand: { flex: 1 },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.sheetActionBorder,
      marginLeft: spacing.md,
    },
    displayText: { flex: 1, gap: spacing.xs },
    displayOption: {
      minHeight: 52,
      paddingVertical: spacing.sm,
      paddingLeft: spacing.xl,
      paddingRight: spacing.md,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    disconnect: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      borderRadius: radius.control,
    },
    disconnectLabel: { color: colors.destructive, fontSize: typeScale.body },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.72 },
  });
