import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { formatByteSize } from './filePreview';
import type { HtmlPreviewProgress } from './mobileHtmlPreview';
import { formatTransferProgress } from './transferProgress';

/** Percentages describe the named resource, not an unknowable whole-page total. */
export function HtmlPreviewLoading({ progress }: { progress?: HtmlPreviewProgress }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    // Cached files normally finish before this; real transfers show their progress immediately.
    const timer = setTimeout(() => setWaiting(true), 200);
    return () => clearTimeout(timer);
  }, []);
  if (!waiting && !progress) return null;
  return <View style={styles.container} testID="filePreview.htmlResourceLoading">
    <ActivityIndicator color={colors.textTertiary} />
    <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('files.preview.fetchingHtmlResources')}</Text>
    {progress ? <>
      <Text numberOfLines={1} style={[styles.meta, { color: colors.textTertiary }]}>{progress.name}</Text>
      {progress.total > 0 ? <Text style={[styles.meta, { color: colors.textTertiary }]}>
        {formatTransferProgress(progress)}
      </Text> : progress.loaded > 0 ? <Text style={[styles.meta, { color: colors.textTertiary }]}>
        {formatByteSize(progress.loaded)}
      </Text> : null}
    </> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.sm, padding: spacing.lg },
  hint: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, textAlign: 'center' },
  meta: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, maxWidth: '100%' },
});
