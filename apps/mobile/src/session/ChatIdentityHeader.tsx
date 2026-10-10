import type { ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { ChevronLeft, Settings2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';

/** Identity mark size in chat headers: a 32pt avatar (1:1) or a 32pt two-member group mark. */
export const CHAT_HEADER_MARK_SIZE = 32;

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
  onOpenSettings(): void;
  settingsLabel: string;
  testIDPrefix: string;
  /** Defaults to `${testIDPrefix}.settings`. */
  settingsTestID?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const open = () => { if (controlsReady) { Keyboard.dismiss(); onOpenSettings(); } };
  return <View style={styles.header} testID={`${testIDPrefix}.header`}>
    <HomeHeaderGlassButton testID={`${testIDPrefix}.back`} accessibilityLabel={t('shared.back')} onPress={() => { Keyboard.dismiss(); onBack(); }}>
      <ChevronLeft size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
    </HomeHeaderGlassButton>
    <Pressable style={({ pressed }) => [styles.identity, pressed && styles.pressed]} accessibilityRole="button"
      accessibilityLabel={identityLabel} accessibilityHint={identityHint} accessibilityState={{ disabled: !controlsReady }}
      disabled={!controlsReady} onPress={open} testID={`${testIDPrefix}.identity`}>
      <View style={styles.mark}>{mark}</View>
      <View style={styles.identityText}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {typeof subtitle === 'string' ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : subtitle}
      </View>
    </Pressable>
    {accessory}
    <HomeHeaderGlassButton testID={settingsTestID ?? `${testIDPrefix}.settings`} disabled={!controlsReady} accessibilityLabel={settingsLabel} onPress={open}>
      <Settings2 size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
    </HomeHeaderGlassButton>
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
