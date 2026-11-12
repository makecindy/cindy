import { useLayoutEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { prNumberLabel, sessionPrUrl } from '@cindy/maker-shared';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { iconSize, iconStroke, useThemedStyles, useTheme, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { useHomeSessionPr } from './HomeSessionInfoMeta';
import { expireHomeSessionPr, homeSessionPrCacheKey, type HomeSessionPrInfo } from './homeSessionPrStore';
import { prStatusVisual } from './prStatusVisual';

/** The task menu shares the home/glance cache and only refreshes while visible. */
export function SessionMenuPrLinks({
  deviceId,
  sessionId,
  updatedAt,
  visible,
}: {
  deviceId: string;
  sessionId: string;
  updatedAt?: string;
  visible: boolean;
}) {
  const { accountGeneration } = useAuth();
  const cacheKey = homeSessionPrCacheKey(String(accountGeneration), deviceId, sessionId, true);
  // Expire before useHomeSessionPr's passive refresh, including menu → details
  // → menu within the ordinary 90-second cache and 10-second debounce windows.
  useLayoutEffect(() => {
    if (visible) expireHomeSessionPr(cacheKey);
  }, [cacheKey, visible]);
  const pr = useHomeSessionPr(deviceId, sessionId, visible, updatedAt, true, true);
  const styles = useThemedStyles(makeStyles);
  if (!pr) return null;
  return (
    <View style={styles.links} testID="session.menuPrLinks">
      {[pr, ...(pr.additional ?? [])].map((item) => (
        <PrLink key={`${deviceId}:${sessionId}:${item.ref.id}`} pr={item} />
      ))}
    </View>
  );
}

function PrLink({ pr }: { pr: HomeSessionPrInfo }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [failed, setFailed] = useState(false);
  const status = pr.status?.ok ? pr.status : null;
  const { Icon, color } = prStatusVisual(status?.status ?? null, colors, status?.conflicts);
  const label = `${pr.ref.owner}/${pr.ref.repo} ${prNumberLabel(pr.ref)}`;
  const state = status
    ? t(`session.githubPrs.status.${status.status}`)
    : t('session.githubPrs.statusUnavailable');
  const statusLabel = status?.conflicts && (status.status === 'open' || status.status === 'draft')
    ? `${state} · ${t('plugins.prStatus.mergeConflict')}`
    : state;
  return (
    <View style={styles.item}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${label} · ${statusLabel}`}
        onPress={() => {
          setFailed(false);
          void Linking.openURL(sessionPrUrl(pr.ref)).catch(() => setFailed(true));
        }}
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
        testID={`session.menuPr.${pr.ref.id}`}
      >
        <Icon color={color} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        <View style={styles.copy}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.status}>{statusLabel}</Text>
        </View>
      </Pressable>
      {failed ? <Text accessibilityRole="alert" style={styles.error}>{t('devices.glance.openFailed')}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  item: { maxWidth: '100%', flexShrink: 1 },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.pill, backgroundColor: colors.surfaceChip,
  },
  pressed: { backgroundColor: colors.border },
  copy: { flexShrink: 1 },
  label: {
    fontSize: typeScale.footnote, lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium, color: colors.textPrimary,
  },
  status: {
    fontSize: typeScale.caption, lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular, color: colors.textTertiary,
  },
  error: {
    fontSize: typeScale.footnote, lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular, color: colors.textSecondary,
  },
});
