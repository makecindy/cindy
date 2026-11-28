import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, typeScale } from '@/theme/tokens';
import { buildMobileChatErrorExplain } from './chatErrorExplain';
import { NoticeExplainSheet } from './NoticeExplainSheet';

/**
 * 未完成回复提示行（对齐桌面 FailedSamplingNotice）：点击弹出底部说明面板，
 * 解释为何保留了半截回复以及如何继续。
 */
export function FailedSamplingNotice() {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  const label = t('message.renderer.failedSamplingAttempt');
  const infoLinkLabel = t('message.modelMismatch.infoLink');

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${infoLinkLabel}`}
        hitSlop={8}
        onPress={() => setOpen(true)}
        style={styles.row}
        testID="message.failedSamplingAttempt"
      >
        <Text style={styles.noticeText}>
          {label}
          {' '}
          <Text style={styles.infoLinkText}>{infoLinkLabel}</Text>
        </Text>
      </Pressable>
      <NoticeExplainSheet
        visible={open}
        onClose={() => setOpen(false)}
        testID="failed-sampling-details"
        content={buildMobileChatErrorExplain('failedSamplingAttempt', t)}
      />
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      alignSelf: 'flex-start',
      paddingVertical: 2,
    },
    noticeText: {
      color: colors.textSecondary,
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
