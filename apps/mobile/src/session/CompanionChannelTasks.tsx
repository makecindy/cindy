import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { REMOTE_RESOURCE_INVOKE_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { lineHeight, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';

type Result<T> = { result?: { ok: boolean; value?: T } };
type Connection = { id: string; botId: string; channel: string; service?: string; identity?: { username?: string | null } };
type Lane = { sessionId: string; name: string | null; chatId: string | null; kind: string };
const client = { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: [] };
function request(op: string, botId?: string, args?: Record<string, unknown>) {
  return [{ client, collectionId: 'teammates', actionId: 'management:settings',
    ...(botId ? { resourceRef: { collectionId: 'teammates', kind: 'bot', id: botId } } : {}),
    input: { v: 1, op, ...(args ? { args } : {}) } }];
}

function requiresHostUpgrade(error: unknown): boolean {
  const transportCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  const code = typeof transportCode === 'string' && transportCode !== 'IPC_ERROR' ? transportCode
    : /^(?:Error invoking remote method '[^']+': Error: )?\[([A-Z0-9_]+)\]/.exec(message)?.[1];
  return code === 'UNSUPPORTED_CAPABILITY' || code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
}

/** Read existing channel tasks; opening one never resets its context or starts a turn. */
export function CompanionChannelTasks({ deviceId, botId, online, onOpenTask }: {
  deviceId: string; botId: string; online: boolean; onOpenTask(id: string): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState<string | null>(null);
  const caps = useRemoteCompanionQuery<Result<{ ops: string[] }>>(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, request('caps'), { enabled: online });
  const supported = caps.value?.result?.ok && ['channels.im.list', 'channels.im.listLanes'].every(op => caps.value?.result?.value?.ops?.includes(op));
  const connections = useRemoteCompanionQuery<Result<{ connections: Connection[] }>>(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, request('channels.im.list', botId), { enabled: online && !!supported });
  const lanes = useRemoteCompanionQuery<Result<{ lanes: Lane[] }>>(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, request('channels.im.listLanes', botId, { id: expanded }), { enabled: online && !!supported && !!expanded });
  const rows = connections.value?.result?.value?.connections?.filter(row => row.botId === botId) ?? [];
  const unsupported = caps.error && requiresHostUpgrade(caps.cause) || caps.value?.result?.ok === true && !supported;
  const failed = caps.error || caps.value?.result?.ok === false || connections.error || connections.value?.result?.ok === false;
  const retry = () => { caps.refresh(); connections.refresh(); lanes.refresh(); };
  return <View style={styles.content}>
    {!online ? <Text style={styles.note}>{t('devices.resources.hostOffline')}</Text>
      : unsupported ? <Text style={styles.note}>{t('devices.companionProfile.hostUpgrade')}</Text> : failed ? <>
      <Text style={styles.note}>{t('devices.companionProfile.readFailed')}</Text>
      <MainWindowActionButton action={{ label: t('devices.resources.retry'), onPress: retry }} />
    </> : !connections.value ? <Text style={styles.note}>{t('devices.resources.loading')}</Text>
      : rows.length === 0 ? <Text style={styles.note}>{t('devices.companionProfile.channelsEmpty')}</Text> : null}
    {rows.map(row => <View key={row.id} style={styles.content}>
      <MainWindowActionButton action={{ label: `${t(`devices.companionProfile.channelPlatforms.${row.service === 'lark' ? 'lark' : row.channel}`, { defaultValue: row.channel })}${row.identity?.username ? ` · ${row.identity.username}` : ''}`, onPress: () => setExpanded(expanded === row.id ? null : row.id) }} />
      {expanded === row.id ? lanes.error || lanes.value?.result?.ok === false ? <>
        <Text style={styles.note}>{t('devices.companionProfile.readFailed')}</Text>
        <MainWindowActionButton action={{ label: t('devices.resources.retry'), onPress: lanes.refresh }} />
      </> : !lanes.value ? <Text style={styles.note}>{t('devices.resources.loading')}</Text>
        : lanes.value.result?.value?.lanes?.length ? lanes.value.result.value.lanes.map(lane => <MainWindowActionButton key={lane.sessionId} action={{
          label: lane.name || lane.chatId || t('devices.companions.openTask'), onPress: () => onOpenTask(lane.sessionId),
        }} />) : <Text style={styles.note}>{t('devices.companionProfile.channelTasksEmpty')}</Text> : null}
    </View>)}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
