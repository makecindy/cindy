import { useEffect, useState } from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";
import { GlassView } from "expo-glass-effect";
import Svg, { Path, Rect } from "react-native-svg";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { iconStroke, useTheme } from "@/theme";
import { radius } from "@/theme/tokens";
import type { MouseControlsProps } from "./RemoteDesktopMouseControls";

export function RemoteDesktopMouseControls(props: MouseControlsProps) {
  return (
    <View
      pointerEvents="box-none"
      style={[
        StyleSheet.absoluteFill,
        { bottom: props.bottom, right: props.right },
      ]}
    >
      {(["left", "right", "wheel"] as const).map((control) => (
        <MouseControl key={control} {...props} control={control} />
      ))}
    </View>
  );
}

function MouseControl({
  control,
  labels,
  compact,
  send,
}: MouseControlsProps & { control: "left" | "right" | "wheel" }) {
  const { colors, mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  const [pressed, setPressed] = useState(false);
  const wheel = control === "wheel";
  const emit = (event: string, id: number, y: number) =>
    send({ type: "nativeMouse", control, event, id, y });
  // A hidden control must never leave a remote mouse button held down.
  useEffect(
    () => () => {
      send({
        type: "nativeMouse",
        control,
        event: "pointercancel",
        id: 0,
        y: 0,
      });
    },
    [control, send],
  );
  const touch = (event: string) => (e: GestureResponderEvent) => {
    setPressed(event === "pointerdown" || event === "pointermove");
    emit(event, 0, e.nativeEvent.pageY);
  };
  const Surface = glass ? GlassView : View;
  const foreground = pressed ? colors.surface : colors.textPrimary;
  return (
    <View
      accessibilityRole="button"
      accessibilityLabel={labels[control]}
      accessibilityState={{ selected: pressed }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => emit("click", 0, 0)}
      onTouchStart={touch("pointerdown")}
      onTouchMove={touch("pointermove")}
      onTouchEnd={touch("pointerup")}
      onTouchCancel={touch("pointercancel")}
      style={[
        styles.control,
        wheel
          ? { right: 12, bottom: compact ? 12 : 80, height: 120 }
          : {
              left: "50%",
              marginLeft: control === "left" ? -96 : 40,
              bottom: 16,
            },
      ]}
      testID={`remoteDesktop.mouse-${control}`}
    >
      <Surface
        {...(glass
          ? {
              glassEffectStyle: "regular" as const,
              isInteractive: true,
              colorScheme: mode,
            }
          : {})}
        pointerEvents="none"
        style={[
          styles.surface,
          {
            backgroundColor: pressed
              ? colors.textPrimary
              : glass
                ? "transparent"
                : colors.surfaceTranslucent,
          },
        ]}
      >
        <Svg
          width={28}
          height={wheel ? 96 : 32}
          viewBox={wheel ? "0 0 24 96" : "0 0 24 32"}
          fill="none"
          stroke={foreground}
          strokeWidth={iconStroke.regular}
        >
          {wheel ? (
            <>
              <Path d="M10 10l2-3 2 3M10 86l2 3 2-3" />
              <Rect x={3} y={31} width={18} height={34} rx={8} />
              <Path d="M5 41h14M4 48h16M5 55h14" />
            </>
          ) : (
            <>
              <Rect x={3} y={2} width={18} height={28} rx={9} />
              <Path d="M12 2v12M3 14h18" />
              <Path
                d={
                  control === "left"
                    ? "M11 3C6 3 4 6 4 10v3h7Z"
                    : "M13 3c5 0 7 3 7 7v3h-7Z"
                }
                fill={foreground}
                stroke="none"
              />
            </>
          )}
        </Svg>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  control: { position: "absolute", width: 56, height: 56 },
  surface: {
    flex: 1,
    borderRadius: radius.pill,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
});
