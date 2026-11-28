import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';
import { SheetModal } from './SheetModal';

export interface NoticeExplainContent {
  title: string;
  summary: string;
  causesTitle: string;
  causes: readonly string[];
  actionsTitle: string;
  actions: readonly string[];
}

/**
 * 移动端统一的「了解原因」底部说明面板（对齐桌面 NoticeExplainPopover）：
 * 以自然语言解释发生了什么、常见成因与可执行的下一步处理建议。
 */
export function NoticeExplainSheet({
  visible,
  onClose,
  content,
  testID = 'notice-explain-details',
}: {
  visible: boolean;
  onClose: () => void;
  content: NoticeExplainContent;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onBackdropPress={onClose}
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.surface,
          { paddingBottom: Math.max(insets.bottom, spacing.lg) },
        ]}
      >
        <ScrollView>
          <View style={styles.content} testID={testID}>
            <Text style={styles.title}>{content.title}</Text>
            <Text style={styles.bodyText}>{content.summary}</Text>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{content.causesTitle}</Text>
              {content.causes.map((item, idx) => (
                <Text key={idx} style={styles.bodyText}>
                  {`• ${item}`}
                </Text>
              ))}
            </View>
            <View style={[styles.section, styles.sectionDivider]}>
              <Text style={styles.sectionTitle}>{content.actionsTitle}</Text>
              {content.actions.map((item, idx) => (
                <Text key={idx} style={styles.bodyText}>
                  {`• ${item}`}
                </Text>
              ))}
            </View>
          </View>
        </ScrollView>
      </View>
    </SheetModal>
  );
}

/**
 * 错误卡片次操作区用的「ⓘ 了解原因」轻按钮（与「错误详情」并排）。
 */
export function NoticeExplainButton({
  content,
  label,
  testID = 'agentError.explain',
}: {
  content: NoticeExplainContent;
  label?: string;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [content.title, content.summary]);

  const buttonLabel = label ?? t('message.modelMismatch.infoLink');

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={buttonLabel}
        onPress={() => setOpen(true)}
        testID={testID}
        style={({ pressed }) => [
          styles.actionToggle,
          pressed && mobileInteractionStyles.pressed,
        ]}
      >
        <Info
          color={colors.textSecondary}
          size={iconSize.sm}
          strokeWidth={iconStroke.regular}
        />
        <Text style={styles.actionLabel}>{buttonLabel}</Text>
      </Pressable>
      <NoticeExplainSheet visible={open} onClose={() => setOpen(false)} content={content} />
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actionToggle: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      minHeight: 44,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
    },
    actionLabel: {
      flexShrink: 1,
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    surface: {
      maxHeight: '75%',
      padding: spacing.lg,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
    },
    content: {
      gap: spacing.md,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
    },
    section: {
      gap: spacing.xs,
    },
    sectionDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: spacing.md,
    },
    sectionTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
    },
    bodyText: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
  });
