import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "@/theme";
import { radius } from "@/theme/tokens";

/**
 * What a scroll area shows of its content (its own scroll metrics; display only). Used by scroll areas that say there is
 * more below without text: the fade over the lower edge and a scroll thumb that stays visible.
 */
export function useScrollOverflow() {
  const [area, setArea] = useState({ visible: 0, content: 0, offset: 0 });
  const overflow = area.content > area.visible + 1;
  return {
    area,
    /** More content below what shows now. */
    more: overflow && area.offset + area.visible < area.content - 2,
    /** The area scrolls at all (more above or below). */
    overflow,
    onLayout: (event: { nativeEvent: { layout: { height: number } } }) => {
      const visible = Math.ceil(event.nativeEvent.layout.height);
      setArea((current) => current.visible === visible ? current : { ...current, visible });
    },
    onContentSizeChange: (_width: number, height: number) => {
      const content = Math.ceil(height);
      setArea((current) => current.content === content ? current : { ...current, content });
    },
    onScroll: (event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const offset = Math.max(0, Math.round(contentOffset.y));
      const content = Math.ceil(contentSize.height), visible = Math.ceil(layoutMeasurement.height);
      setArea((current) => current.offset === offset && current.content === content && current.visible === visible
        ? current : { offset, content, visible });
    },
  };
}
export type ScrollOverflow = ReturnType<typeof useScrollOverflow>;

const THUMB_MIN = 24;
/**
 * A scroll thumb that stays visible while the area scrolls (dispatcher Q-1): Android's own bar takes its color from the
 * native theme, which does not follow the app's light / dark choice (in dark mode it was #151515 on #1E1E1E). This one
 * uses the `borderStrong` token, so it stands out from the surface in both modes. Pair it with
 * `showsVerticalScrollIndicator={false}` on the area. It takes no room and no touches.
 */
export function ScrollThumb({ overflow, testID }: { overflow: ScrollOverflow; testID?: string }) {
  const { colors } = useTheme();
  const { visible, content, offset } = overflow.area;
  if (!overflow.overflow || visible <= 0) return null;
  const height = Math.max(THUMB_MIN, Math.round(visible * visible / content));
  const travel = Math.max(0, visible - height);
  const top = Math.round(travel * Math.min(1, offset / Math.max(1, content - visible)));
  return (
    <View testID={testID} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.thumb, { top, height, backgroundColor: colors.borderStrong }]} />
  );
}

const FADE_STEPS = [0.15, 0.35, 0.6, 0.85];
/**
 * Over a scroll area's lower edge while more is below: bands of the given surface color, more opaque toward the edge
 * (a token, so it follows light and dark mode). No text; it takes no room and no touches.
 */
export function ScrollFade({ color, height, testID }: { color: string; height: number; testID?: string }) {
  return (
    <View testID={testID} pointerEvents="none" style={[styles.fade, { height }]} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {FADE_STEPS.map((opacity) => <View key={opacity} style={[styles.fadeBand, { opacity, backgroundColor: color }]} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  thumb: { position: "absolute", right: 1, width: 3, borderRadius: radius.pill },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  fadeBand: { flex: 1 },
});
