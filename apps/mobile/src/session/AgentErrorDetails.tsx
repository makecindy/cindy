import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

/** Local disclosure only: never retries a request or changes the persisted error. */
export function AgentErrorDetails({ message }: { message: string }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [message]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
        style={styles.toggle}
      >
        <Text style={styles.label}>{t(expanded ? 'session.tail.hideErrorDetails' : 'session.tail.showErrorDetails')}</Text>
      </Pressable>
      {expanded ? <Text selectable style={styles.detail}>{redactSensitiveText(message)}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  toggle: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44, borderRadius: radius.pill, paddingHorizontal: spacing.sm },
  label: { color: colors.textSecondary, fontSize: typeScale.caption },
  detail: { color: colors.textSecondary, fontSize: typeScale.caption },
});
