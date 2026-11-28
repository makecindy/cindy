import { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, typeScale } from '@/theme/tokens';
import { formatModelShortLabel } from './messageActions';
import { NoticeExplainSheet } from './NoticeExplainSheet';

export interface MobileModelMismatchInfo {
  selected: string;
  actual: string;
  providerName?: string;
}

/**
 * Assistant 回复下方常显的模型改派提示行(对齐桌面 ModelMismatchNotice):
 * 明确指出由外部模型供应商改派模型,点击后打开说明面板解释成因与处理方式。
 */
export function ModelMismatchNotice({ mismatch }: { mismatch: MobileModelMismatchInfo }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [mismatch.selected, mismatch.actual, mismatch.providerName]);

  const actual = formatModelShortLabel(mismatch.actual) || mismatch.actual;
  const selected = formatModelShortLabel(mismatch.selected) || mismatch.selected;
  const provider = mismatch.providerName?.trim();

  const noticeText = provider
    ? t('message.modelMismatch.noticeWithProvider', { provider, actual, selected })
    : t('message.modelMismatch.notice', { actual, selected });

  const summaryText = provider
    ? t('message.modelMismatch.infoSummaryWithProvider', { provider, selected, actual })
    : t('message.modelMismatch.infoSummary', { selected, actual });

  const infoLinkLabel = t('message.modelMismatch.infoLink');

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${noticeText} ${infoLinkLabel}`}
        hitSlop={8}
        onPress={() => setOpen(true)}
        style={styles.row}
        testID="message.modelMismatch"
      >
        <TriangleAlert
          color={colors.statusAccent}
          size={iconSize.xs}
          strokeWidth={iconStroke.thin}
          style={styles.leadingIcon}
        />
        <Text numberOfLines={3} style={styles.noticeText}>
          {noticeText}
          {' '}
          <Text style={styles.infoLinkText}>{infoLinkLabel}</Text>
        </Text>
      </Pressable>
      <NoticeExplainSheet
        visible={open}
        onClose={() => setOpen(false)}
        testID="model-mismatch-details"
        content={{
          title: t('message.modelMismatch.infoTitle'),
          summary: summaryText,
          causesTitle: t('message.modelMismatch.infoCausesTitle'),
          causes: [
            t('message.modelMismatch.infoCausePolicy'),
            t('message.modelMismatch.infoCauseLoad'),
            t('message.modelMismatch.infoCauseGateway'),
          ],
          actionsTitle: t('message.modelMismatch.infoActionsTitle'),
          actions: [
            t('message.modelMismatch.infoActionContinue', { selected }),
            t('message.modelMismatch.infoActionRetry'),
            t('message.modelMismatch.infoActionCheckProvider'),
          ],
        }}
      />
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 4,
      maxWidth: '86%',
      paddingVertical: 2,
    },
    leadingIcon: {
      marginTop: 3,
    },
    noticeText: {
      color: colors.textTertiary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    infoLinkText: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      textDecorationLine: 'underline',
    },
  });
