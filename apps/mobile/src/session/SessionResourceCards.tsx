import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale, fontWeight } from '@/theme/tokens';
import type { useSessionResourceCards } from './useSessionResourceCards';

/** Native presentation of bounded host resource primitives; action ids stay opaque. */
export function SessionResourceCards({
  state,
}: {
  state: ReturnType<typeof useSessionResourceCards>;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { height } = useWindowDimensions();
  const cards = state.resources.filter(
    (resource) => resource.blocks?.length || resource.actions?.length,
  );
  if (!cards.length && !state.failed && !state.blocked) return null;
  return (
    <ScrollView
      style={{ maxHeight: height * 0.4 }}
      contentContainerStyle={styles.stack}
      keyboardShouldPersistTaps="handled"
    >
      {!cards.length && state.blocked && !state.failed ? (
        <View style={[styles.card, styles.heading]}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.body}>{t('shared.syncing')}</Text>
        </View>
      ) : null}
      {cards.map((resource) => {
        const title = resolveRemoteText(resource.display.title, i18n.language);
        const body =
          resource.blocks
            ?.map((block) => block.fallbackMarkdown)
            .join('\n\n') ??
          resolveRemoteText(resource.display.subtitle ?? '', i18n.language);
        const busy = resource.blocks?.some(
          (block) =>
            block.primitive === 'session-controls' &&
            (block.data as { busy?: boolean })?.busy,
        );
        return (
          <View
            key={`${resource.ref.collectionId}:${resource.ref.kind}:${resource.ref.id}`}
            style={styles.card}
            testID="session.resourceCard"
          >
            <View style={styles.heading}>
              {(busy && state.fresh) || (!state.fresh && !state.failed) ? (
                <ActivityIndicator color={colors.textSecondary} />
              ) : null}
              <Text style={styles.title}>{title}</Text>
            </View>
            {!state.fresh && !state.failed ? (
              <Text style={styles.body}>{t('shared.syncing')}</Text>
            ) : null}
            {body ? (
              <Text style={styles.body}>
                {body.startsWith(title + '\n\n')
                  ? body.slice(title.length + 2)
                  : body === title
                    ? ''
                    : body}
              </Text>
            ) : null}
            <View style={styles.actions}>
              {resource.actions?.map((action) => (
                <MainWindowActionButton
                  key={action.id}
                  action={{
                    label: resolveRemoteText(action.label, i18n.language),
                    disabled:
                      !state.fresh || !!state.pending || action.disabled,
                    busy: state.pending === action.id,
                    onPress: () => void state.act(resource, action.id),
                  }}
                />
              ))}
            </View>
          </View>
        );
      })}
      {state.failed ? (
        <View style={styles.card}>
          <Text style={styles.body}>{t('session.screen.operationFailed')}</Text>
          <MainWindowActionButton
            action={{
              label: t('devices.resources.retry'),
              onPress: state.refresh,
            }}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm, paddingHorizontal: spacing.md },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.container,
      backgroundColor: colors.surfaceElevated,
      padding: spacing.md,
      gap: spacing.sm,
    },
    heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    body: { color: colors.textSecondary, fontSize: typeScale.footnote },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  });
