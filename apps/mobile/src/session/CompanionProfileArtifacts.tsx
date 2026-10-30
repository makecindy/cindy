import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotDelegationListResult } from '@cindy/maker-shared/botDelegation';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import { companionArtifactRows } from './companionProfileData';
import { lineHeight, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';

/** Existing task-output references only: no workspace scan, copied files or guessed media URLs. */
export function CompanionProfileArtifacts({ deviceId, botId, sessionId, online, onOpenTask }: {
  deviceId: string; botId: string; sessionId: string; online: boolean; onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { value, error, refresh } = useRemoteCompanionQuery<BotDelegationListResult>(deviceId, 'maker:bot-delegations:list', [sessionId], { enabled: online && !!sessionId });
  const rows = companionArtifactRows(value, botId);
  return <View style={styles.content}>
    {!online ? <Text style={styles.note}>{t('devices.resources.hostOffline')}</Text> : null}
    {rows.map(row => <View key={row.id} style={styles.content}>
      <Text style={styles.body}>{row.title}</Text>
      {row.files.map((file, i) => <Text selectable style={styles.note} key={`${file}:${i}`}>{file}</Text>)}
      {row.childSessionId ? <MainWindowActionButton action={{ label: t('devices.companionProfile.openSourceTask'), disabled: !online, onPress: () => {
        onOpenTask(row.childSessionId!);
      } }} /> : null}
    </View>)}
    {error || value?.ok === false ? <><Text style={styles.note}>{t('devices.companionProfile.readFailed')}</Text><MainWindowActionButton action={{ label: t('devices.resources.retry'), disabled: !online, onPress: refresh }} /></> : value?.ok && rows.length === 0 ? <Text style={styles.note}>{t('devices.companionProfile.artifactsEmpty')}</Text> : !value && online ? <Text style={styles.note}>{t('devices.resources.loading')}</Text> : null}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  body: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
