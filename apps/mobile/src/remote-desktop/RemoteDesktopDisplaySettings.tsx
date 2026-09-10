import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import SegmentedControl from "@expo/ui/community/segmented-control";
import { Check, ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type {
  RemoteDesktopDisplayMode,
  RemoteDesktopVideoSettings,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import {
  NativePullDownMenu,
  usesNativePullDownMenu,
} from "@/platform/chrome/NativePullDownMenu";
import {
  spacing,
  radius,
  typeScale,
  iconSize,
  fontWeight,
  useTheme,
} from "@/theme";

type Props = {
  video: {
    supported: boolean;
    settings: RemoteDesktopVideoSettings;
    busy: boolean;
    modesSupported: boolean;
    onChange(settings: Partial<RemoteDesktopVideoSettings>): void;
    readModes(): Promise<RemoteDesktopDisplayMode[]>;
    onResolution(id: string): Promise<void>;
  };
  connected: boolean;
  controlling: boolean;
  displayControl: ReactNode;
};
export function RemoteDesktopDisplaySettings({
  video,
  connected,
  controlling,
  displayControl,
}: Props) {
  const { t } = useTranslation();
  const { colors, mode: colorScheme } = useTheme();
  const [modes, setModes] = useState<RemoteDesktopDisplayMode[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!connected || !video.modesSupported) return;
    let active = true;
    setLoading(true);
    setFailure(false);
    void video
      .readModes()
      .then((next) => {
        if (active) setModes(next);
      })
      .catch(() => {
        if (active) setFailure(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connected, video.modesSupported, reload]);
  const disabled = !connected || !video.supported;
  const title = { color: colors.textPrimary, fontSize: typeScale.body };
  const hint = { color: colors.textTertiary, fontSize: typeScale.caption };
  const segment = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: 44,
          borderRadius: radius.control,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: selected ? colors.cta : "transparent",
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={{
          ...title,
          color: selected ? colors.ctaText : colors.textPrimary,
          fontWeight: selected ? fontWeight.semibold : fontWeight.medium,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  const segments = {
    flexDirection: "row" as const,
    padding: spacing.xs,
    borderRadius: radius.control,
    backgroundColor: colors.surfaceChip,
  };
  const segmented = (
    name: "frameRate" | "quality",
    values: string[],
    selectedIndex: number,
    onSelect: (index: number) => void,
  ) =>
    Platform.OS === "ios" ? (
      <View
        testID={`remoteDesktop.${name}Control`}
        pointerEvents={disabled ? "none" : "auto"}
        accessible={disabled}
        accessibilityLabel={t(`remoteDesktop.${name}`)}
        accessibilityState={{ disabled }}
      >
        <SegmentedControl
          values={values}
          selectedIndex={selectedIndex}
          enabled={!disabled}
          appearance={colorScheme}
          style={{ height: 44 }}
          onChange={({ nativeEvent }) => {
            const index = nativeEvent.selectedSegmentIndex;
            if (!disabled && index >= 0 && index < values.length)
              onSelect(index);
          }}
        />
      </View>
    ) : (
      <View style={segments}>
        {values.map((label, index) =>
          segment(label, index === selectedIndex, () => onSelect(index)),
        )}
      </View>
    );
  const fpsValues = [30, 60] as const;
  const qualityValues = [0, 2000000, 8000000, 20000000] as const;
  const current = modes.find((mode) => mode.current);
  const modeLabel = (mode: RemoteDesktopDisplayMode) =>
    `${mode.width} × ${mode.height}${mode.native === true ? ` · ${t("remoteDesktop.nativeResolution")}` : ""}`;
  const chooseMode = (id: string) => {
    const mode = modes.find((item) => item.id === id);
    if (!mode || mode.current || !controlling || video.busy || !connected)
      return;
    void video
      .onResolution(id)
      .then(() => setExpanded(false))
      .catch(() => {});
  };
  const nativeMenu =
    usesNativePullDownMenu() &&
    connected &&
    video.modesSupported &&
    !loading &&
    !failure &&
    !video.busy &&
    modes.length > 0;
  const resolutionTrigger = (
    <Pressable
      disabled={!connected || !video.modesSupported || loading || video.busy}
      onPress={() =>
        failure ? setReload(reload + 1) : !nativeMenu && setExpanded(!expanded)
      }
      style={styles.row}
      accessibilityRole="button"
      accessibilityState={{ expanded: nativeMenu ? undefined : expanded }}
      accessibilityLabel={
        failure
          ? t("remoteDesktop.retrySettings")
          : t("remoteDesktop.resolution")
      }
    >
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text style={title}>{t("remoteDesktop.resolution")}</Text>
        <Text style={hint} numberOfLines={1}>
          {!video.modesSupported
            ? t("remoteDesktop.settingUnsupported")
            : current
              ? modeLabel(current)
              : t("remoteDesktop.followComputer")}
        </Text>
      </View>
      <View
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {loading || video.busy ? (
          <ActivityIndicator
            size="small"
            color={colors.textTertiary}
            accessibilityLabel={t("remoteDesktop.loadingSettings")}
          />
        ) : (
          <ChevronDown size={iconSize.md} color={colors.textTertiary} />
        )}
      </View>
    </Pressable>
  );
  return (
    <View style={{ gap: spacing.md }}>
      <Text style={hint}>{t("remoteDesktop.frameRate")}</Text>
      {segmented(
        "frameRate",
        fpsValues.map((fps) => t("remoteDesktop.fps", { count: fps })),
        fpsValues.indexOf(video.settings.fps),
        (index) => video.onChange({ fps: fpsValues[index] }),
      )}
      <Text style={hint}>{t("remoteDesktop.quality")}</Text>
      {segmented(
        "quality",
        ["automatic", "clear", "highDefinition", "original"].map((key) =>
          t(`remoteDesktop.${key}`),
        ),
        qualityValues.indexOf(video.settings.bitrate),
        (index) => video.onChange({ bitrate: qualityValues[index] }),
      )}
      <Text style={hint}>{t("remoteDesktop.qualityHint")}</Text>
      <View
        style={{
          backgroundColor: colors.surfaceChip,
          borderRadius: radius.container,
          padding: spacing.md,
          gap: spacing.sm,
        }}
      >
        {displayControl}
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: colors.border,
          }}
        />
        {nativeMenu ? (
          <NativePullDownMenu
            actions={modes.map((mode) => ({
              id: mode.id,
              title: modeLabel(mode),
              state: mode.current ? "on" : "off",
              disabled: !controlling || mode.current,
            }))}
            onAction={chooseMode}
          >
            {resolutionTrigger}
          </NativePullDownMenu>
        ) : (
          resolutionTrigger
        )}
        <Text style={hint}>
          {t(
            controlling
              ? "remoteDesktop.resolutionHint"
              : "remoteDesktop.resolutionControlHint",
          )}
        </Text>
        {!nativeMenu &&
          expanded &&
          modes.map((mode) => (
            <Pressable
              key={mode.id}
              disabled={!controlling || video.busy || mode.current}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode.current }}
              onPress={() => chooseMode(mode.id)}
              style={({ pressed }) => [
                styles.row,
                { opacity: pressed ? 0.6 : !controlling ? 0.4 : 1 },
              ]}
            >
              <Text style={[title, { flex: 1 }]}>{modeLabel(mode)}</Text>
              {mode.current && (
                <Check size={iconSize.md} color={colors.textPrimary} />
              )}
            </Pressable>
          ))}
        {failure && (
          <Text style={hint} accessibilityRole="alert">
            {t("remoteDesktop.retrySettings")}
          </Text>
        )}
      </View>
      {!video.supported && (
        <Text style={hint}>{t("remoteDesktop.settingUnsupported")}</Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
});
