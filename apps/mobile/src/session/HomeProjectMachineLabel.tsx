import { StyleSheet } from 'react-native';
import { MonitorOff, MonitorSmartphone } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, typeScale } from '@/theme/tokens';
import type { HomeProjectMachineIdentity } from './homeProjectMachineIdentity';

/** Desktop ProjectNode / RemoteProjectIcon: icon stays even when the heading owns the label. */
export function HomeProjectMachineLabel({ identity }: { identity: HomeProjectMachineIdentity }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const Icon = identity.disconnected ? MonitorOff : MonitorSmartphone;
  return (
    <>
      <Icon
        color={colors.textSecondary}
        size={iconSize.sm}
        strokeWidth={iconStroke.regular}
        style={identity.disconnected ? styles.disconnected : styles.icon}
      />
      {!identity.hideLabel ? (
        <Text style={styles.label} numberOfLines={1} ellipsizeMode="tail">
          {identity.displayLabel}
        </Text>
      ) : null}
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  icon: { flexShrink: 0 },
  disconnected: { flexShrink: 0, opacity: 0.75 },
  label: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.micro,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    maxWidth: '45%',
  },
});
