import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageStream } from '@/components/chat/MessageStream';
import { Button } from '@/components/ui/button';
import { mapServerMessages } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import type { BotProfile } from './botStore';
import { useBotSettingsTarget } from './useBotSettingsTarget';

/** Uses the ordinary message projection, including attachments and tool results, without a composer. */
export function BotTaskOriginHistory({ bot, onOpenSession }: {
  bot: BotProfile; onOpenSession: (id: string) => void;
}) {
  const { t } = useTranslation();
  const target = useBotSettingsTarget();
  const origin = bot.sourceTask!;
  const [rows, setRows] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const cursor = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const epoch = generation.current;
    setBusy(true); setFailed(false);
    try {
      const options = { originBotId: bot.id, limit: 100, before: cursor.current };
      const result = await (target.deviceId
        ? window.electronAPI.deviceLink.invoke(target.deviceId, 'local-db:messages:list', [origin.sourceSessionId, options])
        : window.electronAPI.localDb!.messages.list(origin.sourceSessionId, options)) as Message[];
      if (epoch !== generation.current) return false;
      cursor.current = result.at(-1)?.id ?? cursor.current;
      setRows(previous => [...previous, ...result]);
      setMore(result.length === 100); setLoaded(true);
      return result.length > 0;
    } catch {
      if (epoch === generation.current) setFailed(true);
      return false;
    } finally {
      if (epoch === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }, [bot.id, origin.sourceSessionId, target.deviceId]);
  useEffect(() => {
    generation.current++; cursor.current = undefined; inFlight.current = false;
    setRows([]); setLoaded(false); setMore(true); void load();
    return () => { generation.current++; };
  }, [load]);
  return <section className="mt-4 flex min-h-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2 px-3">
      <p className="text-13 text-[var(--text-secondary)]">{t('bots.fromTask.history', { title: origin.title })}</p>
      <Button variant="secondary" size="sm" onClick={() => onOpenSession(origin.sourceSessionId)}>{t('bots.fromTask.openSource')}</Button>
    </div>
    {failed ? <p role="alert" className="px-3 text-13 text-[var(--text-danger)]">{t('bots.historySearch.failed')}</p> : null}
    <div className="h-[60vh] min-h-0">
      <MessageStream key={`${bot.id}:${target.deviceId ?? ''}`} fileSessionId={origin.sourceSessionId}
        workingDir={origin.workingDir ?? ''} messages={mapServerMessages(rows)} historyLoaded={loaded}
        onLoadMore={load} hasMoreMessages={more} isLoadingMore={busy} />
    </div>
    {(failed || more) && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>{t('bots.fromTask.loadMore')}</Button>}
  </section>;
}
