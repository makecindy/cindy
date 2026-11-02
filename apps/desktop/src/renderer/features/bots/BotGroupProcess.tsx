import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { projectBotGroupProcess, readBotGroupProcessMessages, type BotGroupProcessRef, type BotGroupProcessMessage, type BotGroupMemberView } from '../../../shared/botGroupChat';
import { WorkGroupBlock, TeammateWorkSegment, type WorkGroupChild } from '@/components/chat/WorkGroupBlock';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
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
  return <BotGroupProcessHistory process={process} deviceId={deviceId} />;
}
function BotGroupProcessHistory({ process, deviceId }: { process: BotGroupProcessRef; deviceId?: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ messages: BotGroupProcessMessage[]; failed: boolean }>();
  const [attempt, retry] = useState(0);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
    setResult(undefined);
    const read = (clientId: string) => deviceId
      ? window.electronAPI.deviceLink.invoke(deviceId, 'local-db:messages:around-client-id', [process.sessionId, clientId, { radius: 80 }]) as Promise<BotGroupProcessMessage[]>
      : window.electronAPI.localDb.messages.aroundClientId(process.sessionId, clientId, { radius: 80 });
    void readBotGroupProcessMessages(process, read, () => !current()).then(messages => {
      if (current()) setResult({ messages, failed: false });
    }).catch(() => { if (current()) setResult({ messages: [], failed: true }); });
    return () => { cancelled = true; };
  }, [process.sessionId, process.clientId, deviceId, attempt, opened]);
  const projection = projectBotGroupProcess(result?.messages ?? [], false);
  return <WorkGroupBlock blockId={`group-process:${process.executionId}`} journal durationMs={process.durationMs ?? projection.durationMs}
    childItems={[{ kind: 'rendered', key: process.executionId, prose: false, renderNode: () => <>
      <MarkProcessVisible onVisible={() => setOpened(true)} />
      {!result && <Spinner size={14} />}
      {result?.failed && <Button variant="secondary" tone="quiet" size="sm" onClick={() => retry(v => v + 1)}>{t('chat.errorBanner.retry')}</Button>}
      {result && <BotGroupProcessEntries messages={result.messages} id={process.executionId} />}
    </> }]} />;
}
function MarkProcessVisible({ onVisible }: { onVisible(): void }) {
  useEffect(onVisible, []);
  return null;
}

/** The same segment component as private chat; records never enter group messages. */
export function BotGroupProcessEntries({ messages, id, running = false }: { messages: readonly BotGroupProcessMessage[]; id: string; running?: boolean }) {
  const { t } = useTranslation();
  const projection = projectBotGroupProcess(messages, running);
  return <div data-testid="bot-group-process-notes" className="flex min-w-0 flex-col gap-3">
    {projection.segments.map((segment, index) => segment.kind === 'content'
      ? <MarkdownRenderer key={segment.key} content={segment.item.text ?? ''} workingDir="" />
      : <TeammateWorkSegment key={segment.key} blockId={`${id}:${segment.key}`} active={running && index === projection.segments.length - 1}
          childItems={segment.items.map(item => item.kind === 'thinking'
            ? { kind: 'thinking', key: item.key, message: { clientId: item.key, role: 'thinking', content: '' } }
            : { kind: 'tools', key: item.key, toolCalls: (item.toolCalls ?? []).map(message => ({ ...message, role: 'tool_use' as const })), resultMap: item.resultMap ?? new Map(), settledIds: item.settledIds ?? new Set() }) as WorkGroupChild[]} />)}
    {running && (!projection.segments.length || projection.segments.at(-1)?.kind === 'content') && <div className="flex items-center gap-2 text-14 text-[var(--text-secondary)]"><Spinner size={14} />{t(projection.segments.length ? 'chat.teammateProcess.thinking' : 'chat.teammateProcess.processing')}</div>}
  </div>;
}
