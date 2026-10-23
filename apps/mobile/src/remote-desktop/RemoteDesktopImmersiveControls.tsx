import type { ComponentProps, ComponentType } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ChevronLeft, Keyboard, SlidersHorizontal, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";
import {
  iconSize,
  iconStroke,
  navigationChrome,
  radius,
  useTheme,
} from "@/theme";
import type { RemoteDesktopToolbar } from "./RemoteDesktopChrome";
import type { PanelButtonProps } from "./RemoteDesktopPanelButton";
import {
  ImmersiveGlassSurface,
  useImmersiveGlass,
} from "./ImmersiveGlassSurface";

/**
 * Back, keyboard and settings of the immersive preview, drawn with plain React
 * Native views. The native controls are SwiftUI Hosts; one mounted here keeps
 * the system status bar on screen (see previewImmersive.ts), and a visible
 * status bar swallows touches on the 54pt strip these controls live in.
 */
const target = navigationChrome.target;

type IconProps = { size: number; strokeWidth: number; color: string };

function useForeground() {
  const { colors, mode } = useTheme();
  const glass = useImmersiveGlass();
  return {
    foreground: glass ? navigationChrome.clear[mode].foreground : colors.textPrimary,
    selectedBackground: glass ? navigationChrome.clear[mode].selected : colors.surfaceChip,
  };
}

function Control({
  testID,
  label,
  Icon,
  selected,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  Icon: ComponentType<IconProps>;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const { foreground, selectedBackground } = useForeground();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.control,
        selected && { backgroundColor: selectedBackground },
        pressed && mobileInteractionStyles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon size={iconSize.action} strokeWidth={iconStroke.regular} color={foreground} />
    </Pressable>
  );
}

export function RemoteDesktopImmersiveBack({
  label,
  onPress,
}: {
  label: string;
  onPress(): void;
}) {
  return (
    <View style={styles.back}>
      <ImmersiveGlassSurface />
      <Control testID="remoteDesktop.back" label={label} Icon={ChevronLeft} onPress={onPress} />
    </View>
  );
}

/** The keyboard panel's close button; the native one is a SwiftUI Host too. */
export function RemoteDesktopImmersivePanelButton({
  back,
  label,
  onPress,
}: PanelButtonProps) {
  return (
    <View style={styles.back}>
      <ImmersiveGlassSurface />
      <Control
        testID="remoteDesktop.panel.back"
        label={label}
        Icon={back ? ChevronLeft : X}
        onPress={onPress}
      />
    </View>
  );
}

export function RemoteDesktopImmersiveToolbar({
  canControl,
  keyboard,
  operations,
  onKeyboard,
  onOperations,
}: Pick<
  ComponentProps<typeof RemoteDesktopToolbar>,
  "canControl" | "keyboard" | "operations" | "onKeyboard" | "onOperations"
>) {
  const { t } = useTranslation();
  return (
    <View testID="remoteDesktop.toolbar" style={styles.toolbar}>
      <ImmersiveGlassSurface />
      <Control
        testID="remoteDesktop.keyboard"
        label={t("remoteDesktop.keyboard")}
        Icon={Keyboard}
        selected={keyboard}
        disabled={!canControl}
        onPress={onKeyboard}
      />
      <Control
        testID="remoteDesktop.operations"
        label={t("remoteDesktop.operations")}
        Icon={SlidersHorizontal}
        selected={operations}
        onPress={onOperations}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  back: { width: target, height: target },
  toolbar: { height: target, flexDirection: "row" },
  control: {
    width: target,
    height: target,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.4 },
});
