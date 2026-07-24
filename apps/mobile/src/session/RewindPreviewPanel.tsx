import {
  ActivityIndicator,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Text } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import type { RewindPreviewState } from '@/session/rewindPreview';
import { buildRewindPreviewLayout } from '@/session/rewindPreviewLayout';
import { fontWeight, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

interface RewindPreviewPanelProps {
  state: RewindPreviewState;
  committing?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function RewindPreviewPanel({
  state,
  committing,
  onCancel,
  onConfirm,
}: RewindPreviewPanelProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  if (state.kind === 'idle') return null;

  const canConfirm = state.kind === 'default' || state.kind === 'empty';
  const title = titleForState(state, t);
  const detail = detailForState(state, t);
  const fileCount = state.kind === 'default' ? state.filesChanged.length : 0;
  const layout = buildRewindPreviewLayout({
    fileCount,
    screenWidth,
  });

  return (
    <View
      style={[
        styles.container,
        {
          marginHorizontal: layout.containerMarginHorizontal,
          padding: layout.containerPadding,
        },
      ]}
      testID="rewind.panel"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        </View>
        {state.kind === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>

      {state.kind === 'default' ? (
        <View style={styles.fileList}>
          {state.filesChanged.slice(0, layout.visibleFileCount).map((file) => (
            <Text
              key={file}
              numberOfLines={1}
              selectable
              style={[styles.filePath, { minHeight: layout.fileRowMinHeight }]}
            >
              {file}
            </Text>
          ))}
          {state.filesChanged.length > layout.visibleFileCount ? (
            <Text style={styles.moreFiles}>{t('interaction.rewind.moreFiles', { count: state.filesChanged.length - layout.visibleFileCount })}</Text>
          ) : null}
          <Text style={styles.stats}>
            {t('interaction.rewind.stats', { count: state.filesChanged.length, insertions: state.insertions, deletions: state.deletions })}
          </Text>
        </View>
      ) : null}

      {state.kind === 'empty' && state.note ? (
        <Text selectable style={styles.note}>{state.note}</Text>
      ) : null}

      {state.kind === 'error' ? (
        <Text selectable style={styles.errorText}>{state.errorText}</Text>
      ) : null}

      {state.kind !== 'loading' ? (
        <MainWindowActionGroup
          cancelAction={{
            accessibilityLabel: state.kind === 'error' ? t('interaction.rewind.gotIt') : t('interaction.rewind.cancelAccessibility'),
            label: state.kind === 'error' ? t('interaction.rewind.gotIt') : t('interaction.rewind.cancel'),
            onPress: onCancel,
            testID: state.kind === 'error' ? 'rewind.dismissButton' : 'rewind.cancelButton',
          }}
          primaryActions={canConfirm ? [{
            accessibilityLabel: t('interaction.rewind.confirm'),
            disabled: committing,
            label: committing ? t('interaction.rewind.confirming') : t('interaction.rewind.confirm'),
            onPress: onConfirm,
            testID: 'rewind.confirmButton',
            tone: 'primary',
          }] : []}
          testID="rewind.actions"
        />
      ) : null}
    </View>
  );
}

function titleForState(state: RewindPreviewState, t: TFunction): string {
  if (state.kind === 'loading') return t('interaction.rewind.titleLoading');
  if (state.kind === 'default') return t('interaction.rewind.titleDefault');
  if (state.kind === 'empty') return t('interaction.rewind.titleEmpty');
  return t('interaction.rewind.titleError');
}

function detailForState(state: RewindPreviewState, t: TFunction): string | null {
  if (state.kind === 'loading') return t('interaction.rewind.detailLoading');
  if (state.kind === 'default') return t('interaction.rewind.detailDefault');
  if (state.kind === 'empty') return t('interaction.rewind.detailEmpty');
  return t('interaction.rewind.detailError');
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  header: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  detail: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, marginTop: 4 },
  fileList: { gap: spacing.xs },
  filePath: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.container,
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  moreFiles: { color: colors.textTertiary, fontSize: typeScale.caption },
  stats: { color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  note: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  errorText: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
});
