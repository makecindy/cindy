import { useRef, useState } from "react";
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useThemedStyles, type ThemeColors } from "@/theme";

/** 种子色的饱和度与亮度固定,用户只挑色相;浅深模式的明暗由共享解析统一处理。 */
const SATURATION = 0.75;
const VALUE = 0.9;
const TRACK = 10;
const THUMB = 28;
const HIT = 44;

export function hueToHex(h: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return VALUE - VALUE * SATURATION * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return (
    "#" +
    [f(5), f(3), f(1)]
      .map((c) => Math.round(c * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function hexToHue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const STOPS = Array.from({ length: 13 }, (_, i) => i * 30);

/**
 * 彩虹色带:外形对齐 iOS 滑块(细轨道 + 圆形滑块),左右点按或拖动选色相。
 * iOS 没有比系统 ColorPicker 更轻的自由选色组件,这里只保留一维选择。
 */
export function UserBubbleHueSlider({
  value,
  label,
  onChange,
  onChangeEnd,
  onDragChange,
}: {
  value: string;
  label: string;
  /** 拖动中逐帧回调,只用于本页预览;不要在这里写全局偏好。 */
  onChange(hex: string): void;
  /** 松手或读屏增减时回调一次,宿主在这里保存。 */
  onChangeEnd(hex: string): void;
  /** 按下/松开时通知宿主,宿主据此暂停外层列表滚动,避免拖动被滚动抢走。 */
  onDragChange?(dragging: boolean): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const hue = hexToHue(value);
  const usable = Math.max(1, width - THUMB);
  const last = useRef(value);
  const pick = (event: GestureResponderEvent) => {
    const x = Math.min(usable, Math.max(0, event.nativeEvent.locationX - THUMB / 2));
    const next = hueToHex((x / usable) * 359);
    if (next !== last.current) {
      last.current = next;
      onChange(next);
    }
  };
  const step = (event: AccessibilityActionEvent) => {
    const delta = event.nativeEvent.actionName === "increment" ? 10 : -10;
    const next = hueToHex(Math.min(359, Math.max(0, hue + delta)));
    onChange(next);
    onChangeEnd(next);
  };
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 0, max: 359, now: Math.round(hue) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={step}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => {
        last.current = value;
        onDragChange?.(true);
        pick(event);
      }}
      onResponderMove={pick}
      onResponderRelease={() => {
        onDragChange?.(false);
        onChangeEnd(last.current);
      }}
      onResponderTerminate={() => {
        onDragChange?.(false);
        onChangeEnd(last.current);
      }}
      style={styles.hit}
      testID="settings.userBubble.hue"
    >
      {width > 0 ? (
        <>
          <Svg
            width={width - THUMB}
            height={TRACK}
            style={styles.track}
            pointerEvents="none"
          >
            <Defs>
              <LinearGradient id="userBubbleHueTrack" x1="0" y1="0" x2="1" y2="0">
                {STOPS.map((h) => (
                  <Stop key={h} offset={h / 360} stopColor={hueToHex(Math.min(h, 359))} />
                ))}
              </LinearGradient>
            </Defs>
            <Rect
              width={width - THUMB}
              height={TRACK}
              rx={TRACK / 2}
              fill="url(#userBubbleHueTrack)"
            />
          </Svg>
          <View
            pointerEvents="none"
            style={[styles.thumb, { left: Math.min(1, hue / 359) * usable }]}
          >
            <View style={[styles.thumbFill, { backgroundColor: value }]} />
          </View>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    hit: { height: HIT, justifyContent: "center" },
    track: { marginHorizontal: THUMB / 2 },
    // 外圈细描边 + 内圈浅色环,在任意色相上都看得清,不用阴影。
    thumb: {
      position: "absolute",
      top: (HIT - THUMB) / 2,
      width: THUMB,
      height: THUMB,
      borderRadius: THUMB / 2,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    thumbFill: {
      flex: 1,
      borderRadius: THUMB / 2,
      borderWidth: 3,
      borderColor: colors.surfaceElevated,
    },
  });
