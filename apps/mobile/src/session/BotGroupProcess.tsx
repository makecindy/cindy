import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { mobileToolRowWording } from '@/i18n/toolWording';
import { projectBotGroupProcess, readBotGroupProcessMessages, type BotGroupProcessRef, type BotGroupProcessMessage } from '@cindy/maker-shared/botGroupChat';
import { projectWorkActivities, summarizeTeammateWork, teammateWorkSummaryText } from '@cindy/maker-shared/work-activity-projection';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useAuth } from '@/auth/AuthContext';
import { useTheme } from '@/theme';
import { spacing, typeScale, lineHeight } from '@/theme/tokens';
import { TeammateProcess, TeammateWorkSegment, useTeammateElapsedTitle } from './TeammateProcess';
import { BotGroupMarkdownText } from './BotGroupMessageText';

export function BotGroupProcess({ process, owned, deviceId }: { process: BotGroupProcessRef; owned: boolean; deviceId: string }) {
  const { accountGeneration } = useAuth();
  const executionDeviceId = process.deviceId || deviceId;
  if (!owned || !executionDeviceId) return null;
  return <BotGroupProcessHistory key={accountGeneration} process={process} deviceId={executionDeviceId} />;
}
function BotGroupProcessHistory({ process, deviceId }: { process: BotGroupProcessRef; deviceId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { invoke } = useDeviceLink();
  const [result, setResult] = useState<{ messages: BotGroupProcessMessage[]; failed: boolean }>();
  const [attempt, retry] = useState(0);
  const [opened, setOpened] = useState(false);
  const duration = useMemo(() => projectBotGroupProcess(result?.messages ?? [], false).durationMs, [result]);
  const title = useTeammateElapsedTitle(false, undefined, process.durationMs ?? duration);
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setResult(undefined);
    void readBotGroupProcessMessages(process, clientId => invoke<BotGroupProcessMessage[]>(deviceId,
      'local-db:messages:around-client-id', [process.sessionId, clientId, { radius: 80 }]), () => cancelled)
      .then(messages => { if (!cancelled) setResult({ messages, failed: false }); })
      .catch(() => { if (!cancelled) setResult({ messages: [], failed: true }); });
    return () => { cancelled = true; };
  }, [invoke, deviceId, process.sessionId, process.clientId, attempt, opened]);
  return <TeammateProcess id={`group-process:${process.executionId}`} title={title}>
    <MarkProcessVisible onVisible={() => setOpened(true)} />
    {!result && <ActivityIndicator color={colors.textSecondary} />}
    {result?.failed && <MainWindowActionButton action={{ label: t('message.renderer.retryPreview'), onPress: () => retry(v => v + 1) }} />}
    {result && <BotGroupProcessEntries messages={result.messages} id={process.executionId} />}
  </TeammateProcess>;
}
function MarkProcessVisible({ onVisible }: { onVisible(): void }) {
  useEffect(onVisible, []);
  return null;
}
export function BotGroupProcessEntries({ messages, id, running = false }: { messages: readonly BotGroupProcessMessage[]; id: string; running?: boolean }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const projection = useMemo(() => projectBotGroupProcess(messages, running), [messages, running]);
  return <View style={{ gap: spacing.md }}>
    {projection.segments.map((segment, index) => {
      if (segment.kind === 'content') return <BotGroupMarkdownText key={segment.key} content={segment.item.text ?? ''} authorKind="bot" />;
      const active = running && index === projection.segments.length - 1;
      const activities = projectWorkActivities(segment.items, active, true).activities;
      const summary = summarizeTeammateWork(activities);
      summary.thinking ||= segment.items.some(item => item.kind === 'thinking');
      return <TeammateWorkSegment key={segment.key} id={`${id}:${segment.key}`} title={teammateWorkSummaryText(summary, active, t, mobileToolRowWording)}
        running={active && (summary.running || !summary.toolCount)} hasTools={summary.toolCount > 0}
        last={index === projection.segments.length - 1}>
        {activities.map(activity => activity.kind === 'tool' ? <View key={activity.key} style={{ gap: spacing.xs }}>
          <Text selectable style={{ color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>{activity.message.toolName}</Text>
          <Text selectable style={{ color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>{JSON.stringify(activity.message.toolInput, null, 2)}</Text>
          {activity.toolResult && <Text selectable style={{ color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall }}>{activity.toolResult}</Text>}
        </View> : null)}
      </TeammateWorkSegment>;
    })}
    {running && (!projection.segments.length || projection.segments.at(-1)?.kind === 'content') && <TeammateWorkSegment id={`${id}:pending`} title={t(projection.segments.length ? 'chat.teammateProcess.thinking' : 'chat.teammateProcess.processing')} running hasTools={false} />}
  </View>;
}
