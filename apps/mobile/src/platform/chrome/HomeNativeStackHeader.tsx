import { memo, useCallback, useState } from "react";
import { Stack } from "expo-router";
import { centeredHomeTitleWidth, HomeStackHeader } from "./HomeStackHeader";
import { homeDisplayAttentionIcon, homeDisplayIcon } from "./homeDisplayIcon";
import { nativeToolbarMenuItems } from "./nativeToolbarMenuItems";
import { AnimationVisibilityProvider, useAnimationVisibility } from "@/hooks/useLoopingAnimation";
import { QuietSyncIndicator } from '@/components/QuietSyncIndicator';
import { useDelayedConnectionNotice } from '@/components/ConnectionNoticeOverlay';
import { ChevronDown } from "lucide-react-native";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/AppText";
import {
  NativePullDownMenu,
  usesNativePullDownMenu,
  type NativePullDownAction,
} from "@/platform/chrome/NativePullDownMenu";
import { usesNativeStackHeader } from "@/platform/chrome/SimpleStackHeader";
import {
  fontWeight,
  iconSize,
  iconStroke,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { lineHeight, navigationChrome, spacing } from "@/theme/tokens";

/** Last settled right edge of the Duo top-left menu, so a remount hugs it without waiting. */
let lastMenuRight: number | null = null;

/**
 * 首页 iOS 顶栏走系统 UINavigationBar。
 * 透明导航栏;标题保留任务范围的长名称避让规则。Android 不渲染。
 *
 * memo:系统顶栏(react-native-screens)每次选项变化都会整组重建 bar button item,展开中的
 * 菜单随之关闭。调用方须传稳定的 props(菜单内容无实质变化时保持同一引用),避免后台同步
 * 之类的无关重渲染把用户正在看的菜单关掉。
 */
export const HomeNativeStackHeader = memo(function HomeNativeStackHeader({
  displayA11y,
  displayActions,
  displayBadge,
  menuA11y,
  onDisplayAction,
  onOpenDeviceMenu,
  onOpenMenu,
  onOpenRemoteDesktop,
  remoteDesktopA11y,
  onSelectScope,
  scopeActions,
  showRemoteGuide,
  syncing = false,
  keepMenuTopLeft = false,
  statusRowReserve = 0,
  title,
  titleA11y,
}: {
  displayA11y: string;
  displayActions: readonly NativePullDownAction[];
  /** 在看已归档任务时,显示菜单按钮带一个点提醒。 */
  displayBadge: boolean;
  menuA11y: string;
  onDisplayAction(id: string): void;
  onOpenDeviceMenu(): void;
  onOpenMenu(): void;
  onOpenRemoteDesktop?: () => void;
  remoteDesktopA11y: string;
  onSelectScope(id: string): void;
  scopeActions: readonly NativePullDownAction[];
  showRemoteGuide: boolean;
  syncing?: boolean;
  keepMenuTopLeft?: boolean;
  /** Trailing width the bar leaves to a shared status row (Duo portrait), see sharedStatusRowTrailingReserve. */
  statusRowReserve?: number;
  title: string;
  titleA11y: string;
}) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nativeMenus = usesNativePullDownMenu();
  const { width } = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const barWidth = width - insets.left - insets.right;
  // UIKit owns where the title view sits and moves it whenever the toolbar
  // changes, without telling React, so the title never reads its position.
  // It only picks the title view's width; UIKit then places it predictably:
  // - a view that fits between mirrored side margins is centered on the bar;
  // - a view spanning the gap between the leading and trailing items is pinned
  //   against the trailing items (UIKit measured that gap at 204pt of 402 with
  //   one leading and two trailing items, see navigationTitleWidth).
  // With one item per side both are the same centered view. With the extra
  // remote-desktop action, a name that fits the mirrored width stays centered;
  // a longer one takes the gap, right-aligned, and grows into the spare room
  // beside the menu before it ellipsizes. Mirrored margins add UIKit's title
  // clearance, otherwise iOS 26 shifts the title toward the leading edge.
  // When the bar shares the status row (Duo portrait) the trailing items sit
  // left of the status area: the gap loses that width and the mirrored margins
  // lose it on both sides, so the sides are asymmetric even with one item.
  // A wide status area (a Live Activity) can push the trailing items past the
  // bar's center; the mirrored width then bottoms out and every name takes
  // the gap, since a centered title would sit under the items.
  const trailingItems = showRemoteGuide ? 0 : onOpenRemoteDesktop ? 2 : 1;
  const reserve = Math.max(0, statusRowReserve);
  const mirroredWidth = centeredHomeTitleWidth(barWidth - reserve * 2, trailingItems);
  const gapWidth = Math.max(navigationChrome.target, Math.min(360,
    barWidth - reserve - navigationChrome.target * (1 + trailingItems) - spacing.lg * 4 - spacing.xs));
  const asymmetric = trailingItems > 1 || (trailingItems > 0 && reserve > 0);
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  // One delayed visibility for the glyph and its measured footprint, so a short
  // sync that never shows the glyph never moves the title either.
  const syncVisible = useDelayedConnectionNotice(syncing);
  const pinnedTrailing = asymmetric
    && naturalWidth != null
    && naturalWidth > mirroredWidth - spacing.xs * 2;
  const titleWidth = showRemoteGuide ? Math.min(220, mirroredWidth)
    : asymmetric && !pinnedTrailing ? mirroredWidth : gapWidth;
  // A vertical system bar (Duo cover screen, landscape) moves the system items into it, and UIKit
  // (iOS 27.1) caps a title view to the mirrored space around its center (84–318pt of the 466pt
  // cover screen), leaving the row's trailing side unused. A custom trailing item stays in the row
  // and ends at the content edge beside the vertical bar, so the title rides there, as wide as the
  // gap after the menu: UIKit moves an item wider than it allows (278pt there) into the vertical
  // bar's overflow menu when it builds the row, and keeps it at least ~33pt from the menu.
  // Like the phone, a name that fits is centered (over the content column); one too long for that
  // sits against the tight side, here the menu, and grows toward the free trailing side before it
  // ellipsizes. Against the menu it starts left of the item, drawn outside it: that first stretch
  // does not take taps, the rest of the name and the chevron do. Until the menu's position is
  // known the name stays inside the item.
  const sideTitle = keepMenuTopLeft && !showRemoteGuide;
  // The trailing item is rendered by the native bar, outside this route's providers: carry the
  // route's visibility with the title so its sync glyph still pauses on hidden surfaces.
  const animationVisible = useAnimationVisibility();
  const sideRequest = Math.max(navigationChrome.target, Math.min(360,
    barWidth - navigationChrome.target - spacing.lg * 4 - spacing.xs));
  const [sideLayoutWidth, setSideLayoutWidth] = useState<number | null>(null);
  const sideWidth = sideLayoutWidth ?? sideRequest;
  const onSideLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (next > 0) setSideLayoutWidth((prev) => prev != null && Math.abs(prev - next) < 0.5 ? prev : next);
  }, []);
  const [menuRight, setMenuRight] = useState<number | null>(() => lastMenuRight);
  const onMenuFrame = useCallback((x: number, w: number) => {
    // A frame outside the bar's leading half is a read from mid-rebuild; keep the last good one.
    if (x < 0 || x + w > width / 2) return;
    lastMenuRight = x + w;
    setMenuRight((prev) => prev != null && Math.abs(prev - (x + w)) < 0.5 ? prev : x + w);
  }, [width]);
  const sideContent = naturalWidth == null ? null : naturalWidth + spacing.xs * 2;
  const contentRight = width - insets.right;
  const sideLeft = contentRight - sideWidth;
  const sideHugLeft = menuRight == null ? sideLeft : Math.min(sideLeft, menuRight + spacing.md);
  // Where the name starts, in window points: centered, but never left of the menu and never past
  // the content edge; offset from the item's own leading edge.
  // On a wide window the centered spot can lie left of the item altogether, where nothing takes
  // taps; keep at least one tap target of the title, chevron included, inside the item.
  const sideOffset = sideContent == null ? 0 : Math.max(
    Math.max(sideHugLeft, Math.min((insets.left + contentRight - sideContent) / 2, contentRight - sideContent)),
    sideLeft + navigationChrome.target - sideContent) - sideLeft;

  if (!usesNativeStackHeader()) return null;

  const titleNode = showRemoteGuide ? (
    <View style={styles.titleHit} testID="devices.title">
      <Text numberOfLines={1} style={styles.title}>
        Cindy
      </Text>
    </View>
  ) : (
    <NativePullDownMenu actions={scopeActions} onAction={onSelectScope}>
      <Pressable
        accessibilityLabel={titleA11y}
        accessibilityRole="button"
        onPress={nativeMenus ? undefined : onOpenDeviceMenu}
        onPressIn={nativeMenus ? undefined : onOpenDeviceMenu}
        style={({ pressed }) => [styles.titleHit,
          sideTitle ? [styles.titleHitLeading,
            { marginLeft: Math.min(0, sideOffset), paddingLeft: spacing.xs + Math.max(0, sideOffset) }]
            : pinnedTrailing && styles.titleHitTrailing,
          pressed && styles.pressed]}
        testID="devices.title"
      >
        {/* The title sits directly on the bar: no capsule material behind it. */}
        <View style={styles.titleCluster}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          <ChevronDown
            color={colors.textSecondary}
            size={iconSize.xs}
            strokeWidth={iconStroke.medium}
          />
          <QuietSyncIndicator active={syncVisible} immediate />
        </View>
      </Pressable>
    </NativePullDownMenu>
  );
  // Unconstrained, invisible copy: its width decides centered vs pinned and
  // must not depend on the width that decision picks.
  const titleMeasure = showRemoteGuide ? null : (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.titleMeasureBox}
    >
      <View
        onLayout={(event) => setNaturalWidth(event.nativeEvent.layout.width)}
        style={styles.titleMeasureRow}
      >
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <ChevronDown size={iconSize.xs} strokeWidth={iconStroke.medium} />
        {/* Same footprint as the sync glyph, without a second accessible spinner. */}
        {syncVisible ? <View style={styles.titleMeasureSync} /> : null}
      </View>
    </View>
  );

  return (
    <HomeStackHeader menuA11y={menuA11y} menuTestID="home.chromeMenu" onOpenMenu={onOpenMenu}
      keepMenuTopLeft={keepMenuTopLeft}
      onMenuFrame={sideTitle ? onMenuFrame : undefined}
      title={sideTitle ? null : <View style={[styles.titleFrame, { width: titleWidth }]}>{titleMeasure}{titleNode}</View>}>
      {showRemoteGuide ? null : (
        <Stack.Toolbar placement="right">
          {sideTitle ? (
            <Stack.Toolbar.View hidesSharedBackground>
              <AnimationVisibilityProvider visible={animationVisible}>
                <View onLayout={onSideLayout} style={[styles.titleFrame, { width: sideRequest }]}>
                  {titleMeasure}{titleNode}
                </View>
              </AnimationVisibilityProvider>
            </Stack.Toolbar.View>
          ) : null}
          {onOpenRemoteDesktop ? <Stack.Toolbar.Button icon={require("../../../assets/navigation/monitor.png")} iconRenderingMode="template"
            accessibilityLabel={remoteDesktopA11y} onPress={onOpenRemoteDesktop} /> : null}
          <Stack.Toolbar.Menu
            icon={displayBadge ? homeDisplayAttentionIcon[mode === "dark" ? "dark" : "light"] : homeDisplayIcon}
            iconRenderingMode={displayBadge ? "original" : "template"}
            accessibilityLabel={displayA11y}
          >
            {nativeToolbarMenuItems(displayActions, onDisplayAction)}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      )}
    </HomeStackHeader>
  );
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    pressed: { opacity: 0.72 },
    titleFrame: {
      flexShrink: 1,
      justifyContent: "center",
      height: navigationChrome.target,
    },
    title: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.title,
    },
    titleCluster: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: spacing.xs,
      maxWidth: "100%",
      minWidth: 0,
    },
    titleHit: {
      paddingHorizontal: spacing.xs,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      minWidth: 44,
    },
    titleHitLeading: { alignItems: "flex-start" },
    titleHitTrailing: { alignItems: "flex-end" },
    titleMeasureBox: {
      left: 0,
      opacity: 0,
      position: "absolute",
      top: 0,
      width: 2000,
    },
    titleMeasureRow: {
      alignItems: "center",
      alignSelf: "flex-start",
      flexDirection: "row",
      gap: spacing.xs,
    },
    titleMeasureSync: { height: iconSize.md, width: iconSize.md },
  });
