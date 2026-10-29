import { memo, type ReactNode } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
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
  children,
}: {
  title: ReactNode;
  menuA11y: string;
  menuTestID: string;
  onOpenMenu(): void;
  keepMenuTopLeft?: boolean;
  /** Route-owned native toolbars; keep items inside their Stack.Toolbar container. */
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  return <>
    <Stack.Screen options={{
      headerBackVisible: false, headerShadowVisible: false, headerShown: true,
      headerStyle: { backgroundColor: 'transparent' }, headerTintColor: colors.textPrimary,
      headerTransparent: true, headerTitleAlign: 'center', headerTitle: () => title,
    }} />
    <Stack.Header style={{ backgroundColor: 'transparent', color: colors.textPrimary, shadowColor: 'transparent' }} />
    <Stack.Toolbar placement="left">
      {keepMenuTopLeft ? (
        // Duo keeps the menu at top left, inside the native bar's hit surface.
        <Stack.Toolbar.View hidesSharedBackground>
          <View style={styles.menu}>
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

const styles = StyleSheet.create({
  artwork: { width: homeMenuArtworkSize, height: homeMenuArtworkSize },
  menu: { width: navigationChrome.target, height: navigationChrome.target },
});
