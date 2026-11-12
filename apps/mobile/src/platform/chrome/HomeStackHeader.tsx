import type { ViewInstance } from 'react-native';
import { memo, useEffect, useRef, type ReactNode } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { useAnimationVisibilityBridge } from '@/hooks/useLoopingAnimation';
import { HomeHeaderGlassButton } from '@/session/HomeHeaderGlassButton';
import { useTheme } from '@/theme';
import { navigationChrome, spacing } from '@/theme/tokens';
import { homeMenuArtworkSize, homeMenuIcon } from './homeMenuIcon';

/**
 * Widest title view UIKit keeps centered on the bar: mirrored side margins sized for the
 * larger side's items plus UIKit's title clearance. The cap keeps wide windows, whose
 * bar margins differ, from clipping both ends.
 */
export function centeredHomeTitleWidth(barWidth: number, trailingItems: number): number {
  return Math.max(navigationChrome.target, Math.min(360,
    barWidth - (navigationChrome.target * Math.max(1, trailingItems) + spacing.lg * 2 + spacing.md) * 2));
}

/**
 * Shared iOS home chrome. Callers own title content and business actions, not bar geometry.
 * The bar's blur is drawn once by the home route, behind the bar.
 */
export const HomeStackHeader = memo(function HomeStackHeader({
  title,
  menuA11y,
  menuTestID,
  onOpenMenu,
  keepMenuTopLeft = false,
  onMenuFrame,
  children,
}: {
  title: ReactNode;
  menuA11y: string;
  menuTestID: string;
  onOpenMenu(): void;
  keepMenuTopLeft?: boolean;
  /** Window x and width of the kept top-left menu, read once UIKit has settled the row. */
  onMenuFrame?(x: number, width: number): void;
  /** Route-owned native toolbars; keep items inside their Stack.Toolbar container. */
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  const menuRef = useRef<ViewInstance>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  // UIKit animates rebuilt bar items into place without a new layout pass, so a position read
  // right away can be stale; read it once the row has been still for a moment.
  const measureMenu = onMenuFrame ? () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      menuRef.current?.measureInWindow((x, _y, width) => { if (width > 0) onMenuFrame(x, width); });
    }, MENU_SETTLE_MS);
  } : undefined;
  const visibleTitle = useAnimationVisibilityBridge(title);
  return <>
    <Stack.Screen options={{
      headerBackVisible: false, headerShadowVisible: false, headerShown: true,
      headerStyle: { backgroundColor: 'transparent' }, headerTintColor: colors.textPrimary,
      headerTransparent: true, headerTitleAlign: 'center', headerTitle: () => visibleTitle,
    }} />
    <Stack.Header style={{ backgroundColor: 'transparent', color: colors.textPrimary, shadowColor: 'transparent' }} />
    <Stack.Toolbar placement="left">
      {keepMenuTopLeft ? (
        // Duo keeps the menu at top left, inside the native bar's hit surface.
        <Stack.Toolbar.View hidesSharedBackground>
          <View ref={menuRef} onLayout={measureMenu} style={styles.menu}>
            <HomeHeaderGlassButton accessibilityLabel={menuA11y} onPress={onOpenMenu} testID={menuTestID} artworkSize={homeMenuArtworkSize}>
              <Image source={homeMenuIcon} tintColor={colors.textPrimary} style={styles.artwork} />
            </HomeHeaderGlassButton>
          </View>
        </Stack.Toolbar.View>
      ) : (
        <Stack.Toolbar.Button icon={homeMenuIcon} iconRenderingMode="template" accessibilityLabel={menuA11y} onPress={onOpenMenu} />
      )}
    </Stack.Toolbar>
    {children}
  </>;
});

const MENU_SETTLE_MS = 250;

const styles = StyleSheet.create({
  artwork: { width: homeMenuArtworkSize, height: homeMenuArtworkSize },
  menu: { width: navigationChrome.target, height: navigationChrome.target },
});
