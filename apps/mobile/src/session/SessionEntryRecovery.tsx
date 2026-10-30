import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

/** Local entry chrome stays available even when remote task content cannot mount. */
export function SessionEntryStatus({ title, copy, loading, children }: {
  title: string; copy: string; loading?: boolean; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <MainWindowEmptyState title={title} copy={copy} centered style={styles.card} testID="session.entryStatus">
          {loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <View style={styles.actions}>
            {children}
            <MainWindowActionButton action={{
              label: t('session.entry.back'), testID: 'session.entryBack',
              onPress: () => goBackGuarded(router),
            }} numberOfLines={0} />
          </View>
        </MainWindowEmptyState>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.surfaceElevated, padding: spacing.xl },
  actions: { gap: spacing.sm, marginTop: spacing.md },
});
