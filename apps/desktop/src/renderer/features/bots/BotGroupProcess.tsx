import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SESSION_SYNC_CHANNEL } from '@cindy/device-link';
import { projectBotGroupProcess, readBotGroupProcessMessages, type BotGroupProcessRef, type BotGroupProcessMessage, type BotGroupMemberView } from '../../../shared/botGroupChat';
import { WorkGroupBlock, TeammateWorkSegment, type WorkGroupChild } from '@/components/chat/WorkGroupBlock';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { createRemoteSessionSubscription } from '@/lib/remoteSessionSubscription';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { useBotProfiles } from './botStore';
import { companionRunsHere } from './companionCloudPresentation';
import { useCompanionCloud } from './companionCloudStore';

export function BotGroupProcess({ process, member }: { process: BotGroupProcessRef; member?: BotGroupMemberView }) {
  const cloud = useCompanionCloud();
  const profiles = useBotProfiles();
  const actor = cloud.actors.find(actor => actor.id === member?.botId || actor.externalId === member?.botId);
  if (!member || member.isOwned === false || (!actor && member.isOwned !== true)) return null;
  const runsHere = companionRunsHere(cloud, profiles.map(bot => bot.id), actor?.externalId ?? member.botId);
  const deviceId = process.deviceId
    ? process.deviceId === cloud.selfDeviceId ? undefined : process.deviceId
    : runsHere ? undefined : actor?.homeDeviceId ?? member.homeDeviceId ?? undefined;
  if (!process.deviceId && !runsHere && !deviceId) return null;
  return <BotGroupProcessHistory key={`${deviceId ?? 'local'}:${process.sessionId}:${process.clientId}:${process.executionId}`} process={process} deviceId={deviceId} />;
}
function BotGroupProcessHistory({ process, deviceId }: { process: BotGroupProcessRef; deviceId?: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ messages: BotGroupProcessMessage[]; failed: boolean }>();
  const [attempt, retry] = useState(0);
  const [subscriptionFailed, setSubscriptionFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSubscriptionFailed(false);
    const owner = getDataOwnerGeneration();
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
    const read = (clientId: string) => deviceId
      ? window.electronAPI.deviceLink.invoke(deviceId, 'local-db:messages:around-client-id', [process.sessionId, clientId, { radius: 80 }], { background: true }) as Promise<BotGroupProcessMessage[]>
      : window.electronAPI.localDb.messages.aroundClientId(process.sessionId, clientId, { radius: 80 });
    let reading = false;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = deviceId ? createRemoteSessionSubscription(deviceId, process.sessionId) : undefined;
    let closed = false;
    let peerAvailable: boolean | undefined;
    const stopUpdates = () => { if (closed) return; closed = true; clearTimeout(timer); off(); recoveryOffs.forEach(off => off?.()); subscription?.release(); if (current()) setSubscriptionFailed(false); };
    const refresh = () => {
      if (!current() || closed) return;
      if (reading) { refreshPending = true; return; }
      clearTimeout(timer);
      reading = true;
      refreshPending = false;
      const active = () => current();
      setLoading(true);
      void readBotGroupProcessMessages(process, read, () => !active(), () => { if (active()) stopUpdates(); }).then(messages => {
        if (active()) { setResult({ messages, failed: false }); setLoading(false); }
      }).catch(() => {
        if (active()) { setResult(previous => ({ messages: previous?.messages ?? [], failed: true })); setLoading(false); }
      }).finally(() => {
        reading = false;
        if (refreshPending) refresh();
      });
    };
    const changed = (sessionId: unknown) => {
      if (!current() || closed || sessionId !== process.sessionId) return;
      // Keep one read in flight; changes during it become one trailing read.
      if (reading) { refreshPending = true; return; }
      // A persisted tool batch can contain several records. Read once after it settles.
      clearTimeout(timer);
      timer = setTimeout(refresh, 50);
    };
    const off = deviceId
      ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
        if (!isDataOwnerPushCurrent(stamp) || push.deviceId !== deviceId) return;
        const payload = push.payload as { sessionId?: string; resyncRequired?: boolean } | null;
        if (push.channel === 'local-db:messages:created'
          || push.channel === SESSION_SYNC_CHANNEL && payload?.resyncRequired === true) changed(payload?.sessionId);
      })
      : window.electronAPI.localDb.messages.onCreated(({ sessionId }, stamp) => {
        if (isDataOwnerPushCurrent(stamp)) changed(sessionId);
      });
    // Replayed subscriptions restore future pushes, not records whose push was
    // lost during a disconnect. Reconcile this bounded turn on peer recovery.
    const recover = () => {
      if (!current() || closed) return;
      // Failed first subscriptions leave Main no topic to replay. Share an
      // existing ACK or reacquire it before recovering the bounded snapshot.
      void subscription?.subscribe({ reuse: true }).then(() => {
        if (current() && !closed) setSubscriptionFailed(false);
        changed(process.sessionId);
      }).catch(() => {
        if (current() && !closed) {
          setSubscriptionFailed(true);
          setLoading(false);
        }
      });
    };
    const recoveryOffs = deviceId ? [
      window.electronAPI.deviceLink.onPeerLinkReset?.(p => {
        if (p.deviceId === deviceId) recover();
      }),
      window.electronAPI.deviceLink.onPresenceChanged?.(p => {
        if (p.deviceId !== deviceId) return;
        const available = p.online && p.remoteControlEnabled;
        const recovered = available && peerAvailable !== true;
        peerAvailable = available;
        if (recovered) recover();
      }),
      window.electronAPI.deviceLink.onResponsivenessChanged?.(p => {
        if (p.deviceId === deviceId && !p.unresponsive && p.recovered !== false) recover();
      }),
      window.electronAPI.deviceLink.onStatusChanged?.(p => {
        if (p.dataPathChangedDeviceId && p.dataPathChangedDeviceId !== deviceId) return;
        if (p.status === 'stopped') peerAvailable = false;
        if (p.status === 'online' || p.directDataDeviceIds?.includes(deviceId)) recover();
      }),
    ] : [];
    // A readable snapshot does not prove that subsequent pushes are subscribed.
    void subscription?.subscribe().then(() => {
      if (current() && !closed) peerAvailable ??= true;
    }).catch(() => {
      if (current() && !closed) { peerAvailable = false; setSubscriptionFailed(true); }
    });
    refresh();
    return () => {
      cancelled = true;
      stopUpdates();
    };
  }, [process.sessionId, process.clientId, deviceId, attempt]);
  const projection = projectBotGroupProcess(result?.messages ?? [], false);
  const failed = result?.failed || subscriptionFailed;
  // Resolve availability before advertising a disclosure, just like private chat.
  if (!result) return null;
  return <WorkGroupBlock pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} blockId={`group-process:${process.executionId}`} journal durationMs={process.durationMs ?? projection.durationMs}
    childItems={[{ kind: 'rendered', key: process.executionId, renderNode: () => <>
      {loading && <Spinner size={14} />}
      {failed && !loading && <>
        <p className="text-14 text-[var(--text-secondary)]">{t('chat.teammateProcess.unavailable')}</p>
        <Button variant="secondary" tone="quiet" size="sm" onClick={() => retry(v => v + 1)}>{t('chat.errorBanner.retry')}</Button>
      </>}
      {projection.segments.length
        ? <BotGroupProcessEntries messages={result.messages} id={`group-process:${process.executionId}`} />
        : !failed && !loading && <p className="text-14 text-[var(--text-secondary)]">{t('chat.teammateProcess.empty')}</p>}
    </> }]} />;
}

/** The same segment component as private chat; records never enter group messages. */
export function BotGroupProcessEntries({ messages, id, running = false }: { messages: readonly BotGroupProcessMessage[]; id: string; running?: boolean }) {
  const projection = projectBotGroupProcess(messages, running);
  return <div data-testid="bot-group-process-notes" className="flex min-w-0 flex-col gap-3">
    {projection.segments.map((segment, index) => segment.kind === 'content'
      ? <MarkdownRenderer key={segment.key} content={segment.item.text ?? ''} workingDir="" />
      : <TeammateWorkSegment pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} key={segment.key} blockId={`${id}:${segment.key}`} active={running && index === projection.segments.length - 1}
          childItems={segment.items.map(item => item.kind === 'thinking'
            ? { kind: 'thinking', key: item.key, message: { clientId: item.key, role: 'thinking', content: '' } }
            : { kind: 'tools', key: item.key, toolCalls: (item.toolCalls ?? []).map(message => ({ ...message, role: 'tool_use' as const })), resultMap: item.resultMap ?? new Map(), settledIds: item.settledIds ?? new Set() }) as WorkGroupChild[]} />)}
  </div>;
}
