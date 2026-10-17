import type { ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { Settings2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { NativeChromeBackButton } from '@/platform/chrome/NativeChromeBackButton';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
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
 * 设置。点身份区和设置按钮打开同一份资料 / 设置。
 */
export function ChatIdentityHeader({
  accessory, mark, title, subtitle, identityLabel, identityHint, controlsReady = true, onBack, onOpenSettings, settingsLabel, testIDPrefix, settingsTestID,
}: {
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
  return <View style={styles.header} testID={`${testIDPrefix}.header`}>
    {/* Same system back as the task header. */}
    <NativeChromeBackButton testID={`${testIDPrefix}.back`} label={t('shared.back')} onPress={() => { Keyboard.dismiss(); onBack(); }} />
    <Pressable style={({ pressed }) => [styles.identity, pressed && styles.pressed]} accessibilityRole={settings ? 'button' : 'header'}
      accessibilityLabel={identityLabel} accessibilityHint={settings ? identityHint : undefined}
      accessibilityState={settings ? { disabled: !controlsReady } : undefined}
      disabled={!controlsReady || !settings} onPress={open} testID={`${testIDPrefix}.identity`}>
      <View style={styles.mark}>{mark}</View>
      <View style={styles.identityText}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {typeof subtitle === 'string' ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : subtitle}
      </View>
    </Pressable>
    {accessory}
    {settings ? <HomeHeaderGlassButton testID={settingsTestID ?? `${testIDPrefix}.settings`} disabled={!controlsReady} accessibilityLabel={settingsLabel ?? ''} onPress={open}>
      <Settings2 size={iconSize.lg} strokeWidth={CHAT_HEADER_GLYPH_STROKE} color={colors.textPrimary} />
    </HomeHeaderGlassButton> : null}
  </View>;
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
