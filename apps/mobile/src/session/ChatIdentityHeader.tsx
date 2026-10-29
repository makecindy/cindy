import { useMemo, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Settings2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { NativeChromeBackButton } from '@/platform/chrome/NativeChromeBackButton';
import { fontWeight, iconSize, iconStroke, lineHeight, navigationChrome, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';

/** Identity mark size in chat headers: a 32pt avatar (1:1) or a 32pt two-member group mark. */
export const CHAT_HEADER_MARK_SIZE = 32;
/** 18pt trailing glyphs at ~1.65pt, level with the 20pt back chevron rather than thinner beside it. */
export const CHAT_HEADER_GLYPH_STROKE = iconStroke.medium;
/**
 * The identity's subtitle runs to the header's lower edge, so the header blur stays solid across
 * the whole header and feathers only below it.
 */
export const CHAT_HEADER_BLUR_FADE_INSIDE = 0;

/**
 * 私聊与群聊共用的顶栏（C1 / G1）：返回 + 身份区（32 标记、标题 16/22 600、副标题 12/18 三级色）+
 * 设置。点身份区默认与设置按钮打开同一份资料 / 设置；伙伴私聊的身份区打开近况（onOpenIdentity）。
 */
export function ChatIdentityHeader({
  nativeHeader = false, accessory, mark, title, subtitle, identityLabel, identityHint, controlsReady = true, onBack, onOpenSettings, onOpenIdentity, settingsLabel, testIDPrefix, settingsTestID,
}: {
  /** The caller reserves the measured iOS navigation bar height, including the status area. */
  nativeHeader?: boolean;
  accessory?: ReactNode;
  mark: ReactNode;
  title: string;
  /** A short line under the title: presence + computer name, or member names. */
  subtitle: ReactNode;
  identityLabel: string;
  identityHint?: string;
  controlsReady?: boolean;
  onBack(): void;
  /** Omitted when there is nothing to open (the identity is then plain, without a settings button). */
  onOpenSettings?(): void;
  /** Tapping the identity opens this instead of the settings (the teammate's 近况). */
  onOpenIdentity?(): void;
  settingsLabel?: string;
  testIDPrefix: string;
  /** Defaults to `${testIDPrefix}.settings`. */
  settingsTestID?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const settings = !!onOpenSettings;
  const open = () => { if (controlsReady && onOpenSettings) { Keyboard.dismiss(); onOpenSettings(); } };
  const identityAction = onOpenIdentity ?? onOpenSettings;
  const openIdentity = () => { if (controlsReady && identityAction) { Keyboard.dismiss(); identityAction(); } };
  const back = <NativeChromeBackButton testID={`${testIDPrefix}.back`} label={t('shared.back')} onPress={() => { Keyboard.dismiss(); onBack(); }} />;
  const identity = <Pressable style={({ pressed }) => [styles.identity, pressed && styles.pressed]} accessibilityRole={identityAction ? 'button' : 'header'}
      accessibilityLabel={identityLabel} accessibilityHint={identityAction ? identityHint : undefined}
      accessibilityState={identityAction ? { disabled: !controlsReady } : undefined}
      disabled={!controlsReady || !identityAction} onPress={openIdentity} testID={`${testIDPrefix}.identity`}>
      {mark ? <View style={styles.mark}>{mark}</View> : null}
      <View style={styles.identityText}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {typeof subtitle === 'string' ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : subtitle}
      </View>
    </Pressable>;
  const actions = <>{accessory}{settings ? <HomeHeaderGlassButton testID={settingsTestID ?? `${testIDPrefix}.settings`} disabled={!controlsReady} accessibilityLabel={settingsLabel ?? ''} onPress={open}>
      <Settings2 size={iconSize.lg} strokeWidth={CHAT_HEADER_GLYPH_STROKE} color={colors.textPrimary} />
    </HomeHeaderGlassButton> : null}</>;
  if (nativeHeader) return <NativeChatHeader identity={identity} back={back} actions={actions} actionCount={Number(settings) + Number(!!accessory)} />;
  return <View style={styles.header} testID={`${testIDPrefix}.header`}>
    {back}{identity}{actions}
  </View>;
}

/** Keep controls inside UIKit's hit surface when Duo shares navigation with the status row. */
function NativeChatHeader({ identity, back, actions, actionCount }: {
  identity: ReactNode; back: ReactNode; actions: ReactNode; actionCount: number;
}) {
  const { colors } = useTheme();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [actionsWidth, setActionsWidth] = useState(0);
  // A text action (Follow/Following) is wider than an icon. Reserve its measured
  // width so UIKit keeps the custom view on the bar instead of an inert overflow item.
  const trailingWidth = Math.max(navigationChrome.target * Math.max(1, actionCount), actionsWidth);
  const width = Math.max(0, Math.min(240, window.width - insets.left - insets.right
    - (trailingWidth + spacing.lg * 2 + spacing.md) * 2));
  const options = useMemo(() => ({ headerShown: true, headerTransparent: true, headerShadowVisible: false,
    headerBackVisible: false, headerTintColor: colors.textPrimary,
    headerStyle: { backgroundColor: 'transparent' }, headerTitle: '',
  }), [colors.textPrimary]);
  return <>
    <Stack.Screen options={options} />
    <Stack.Toolbar placement="left"><Stack.Toolbar.View hidesSharedBackground>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        {back}<View style={{ width, height: navigationChrome.target }}>{identity}</View>
      </View>
    </Stack.Toolbar.View></Stack.Toolbar>
    {actionCount > 0 ? <Stack.Toolbar placement="right"><Stack.Toolbar.View hidesSharedBackground>
      <View style={{ flexDirection: 'row', gap: spacing.md }} onLayout={({ nativeEvent }) => {
        setActionsWidth(Math.ceil(nativeEvent.layout.width));
      }}>{actions}</View>
    </Stack.Toolbar.View></Stack.Toolbar> : null}
  </>;
}

/** Subtitle text in the header's style, for callers that compose it with a leading mark. */
export function ChatIdentitySubtitle({ children }: { children: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text numberOfLines={1} style={[styles.subtitle, styles.subtitleFlexible]}>{children}</Text>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: spacing.md, paddingHorizontal: spacing.lg },
  identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.sm + 2 },
  pressed: { opacity: 0.72 },
  mark: { width: CHAT_HEADER_MARK_SIZE, height: CHAT_HEADER_MARK_SIZE },
  identityText: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold },
  subtitle: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  subtitleFlexible: { flexShrink: 1 },
});
