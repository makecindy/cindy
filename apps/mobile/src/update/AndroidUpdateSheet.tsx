import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { ContextSheet } from '@/session/ContextSheet';
import { spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { androidInstaller } from './androidInstaller';

/** Mounted outside the business tree so forced updates have the same working installer. */
export function AndroidUpdateSheet() {
  const state = useSyncExternalStore(androidInstaller.subscribe, androidInstaller.getSnapshot);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const busy = state.phase === 'permission' || state.phase === 'downloading' || state.phase === 'installing';
  const status = state.phase === 'permission' ? t('update.android.permissionPending')
    : state.phase === 'permission-required' ? t('update.android.permissionRequired')
    : state.phase === 'permission-denied' ? t('update.android.permissionDenied')
    : state.phase === 'error' ? t('update.android.failed')
    : state.phase === 'installing' ? t('update.android.installing')
    : state.phase === 'ready' ? t('update.android.ready')
    : state.progress === null ? t('update.android.downloading')
    : t('update.android.downloadProgress', { percent: Math.floor(state.progress * 100) });
  const permissionNeeded = state.phase === 'permission-required' || state.phase === 'permission-denied';
  const actionLabel = permissionNeeded ? t('update.android.grantPermission')
    : state.phase === 'ready' ? t('update.android.install') : t('update.android.retry');
  return (
    <ContextSheet
      visible={state.phase !== 'idle'}
      title={t('update.newVersionTitle')}
      onClose={androidInstaller.close}
      keyboardAvoidingBehavior={undefined}
      testID="update.android"
    >
      <View style={styles.content}>
        <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
        {busy ? <ActivityIndicator color={colors.textSecondary} /> : (
          <>
            <MainWindowActionButton action={{
              label: actionLabel,
              onPress: androidInstaller.retry,
              tone: 'primary',
              testID: 'update.android.retry',
            }} />
            <MainWindowActionButton action={{
              label: t('update.android.browser'),
              onPress: () => { void androidInstaller.browser(); },
              testID: 'update.android.browser',
            }} />
          </>
        )}
        <MainWindowActionButton action={{
          label: busy ? t('update.android.cancel') : t('update.later'),
          onPress: androidInstaller.close,
          testID: 'update.android.cancel',
        }} />
      </View>
    </ContextSheet>
  );
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.lg, padding: spacing.lg },
  status: { color: colors.textPrimary, fontSize: typeScale.body },
});
