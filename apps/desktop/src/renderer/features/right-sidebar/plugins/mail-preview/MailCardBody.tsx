import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { readMailCard } from '@cindy/maker-shared/ghost-card-form';
import { getGhostCardSnapshot, subscribeGhostCards } from '@/cindy-brain/ghostCardStore';
import { MailCardEditor } from '@/components/chat/GhostToolCard';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import type { TabKindBodyProps } from '../../types';

type Card = { callId: string; ghostId: string; html: string; height: number };

/** Resolve only within this task. Persisted tab state contains an ID, never mail text. */
export function MailCardBody({ state, ctx }: TabKindBodyProps<{ callId: string }>) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribeGhostCards, getGhostCardSnapshot);
  const owner = getDataOwnerGeneration();
  const binding = JSON.stringify([owner, ctx.sessionId, ctx.deviceLinkDeviceId, state.callId]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ binding: string; cards: Card[]; requested?: string; error?: boolean }>();
  const rows = result?.binding === binding ? result.cards : [];
  let current = rows.find(c => c.callId === state.callId);
  let missing: string | undefined;
  const visited = new Set<string>();
  while (current && !visited.has(current.callId)) {
    visited.add(current.callId);
    const pushed = snapshot.byCallId.get(current.callId);
    if (pushed?.status === 'ready') current = { ...current, ...pushed };
    const mail = readMailCard(current.html);
    if (!mail) { current = undefined; break; }
    if (!mail.supersededBy) break;
    const next = rows.find(c => c.callId === mail.supersededBy);
    if (!next) { missing = mail.supersededBy; current = undefined; break; }
    const nextMail = readMailCard(next.html);
    if (visited.has(next.callId) || next.ghostId !== current.ghostId ||
      nextMail?.accountId !== mail.accountId || nextMail.draftId !== mail.draftId) { current = undefined; break; }
    current = next;
  }
  useEffect(() => {
    let active = true;
    if (ctx.deviceLinkDeviceId === undefined) return;
    // This editor uses local card actions. Never resolve a remote task's ID locally.
    if (ctx.deviceLinkDeviceId) { setResult({ binding, cards: [], error: true }); return; }
    void window.electronAPI.ghosts.listCardsBySession(ctx.sessionId).then(({ cards }) => {
      if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, cards, requested: missing });
    }).catch(() => { if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, cards: [], requested: missing, error: true }); });
    return () => { active = false; };
  }, [binding, missing, attempt]);
  const failed = result?.binding === binding && !current && (!missing || result.requested === missing);
  return <div className="h-full overflow-auto">
    {current ? <ChatSessionFileProvider value={{ sessionId: ctx.sessionId, workingDir: ctx.workdir, origin: { kind: 'local' } }}>
      <article className="mx-auto max-w-[960px] px-1 py-2" data-mail-panel-call-id={current.callId}>
        <MailCardEditor key={`${binding}:${current.callId}`} callId={current.callId} html={current.html} height={current.height} sessionId={ctx.sessionId} />
      </article>
    </ChatSessionFileProvider> : <div className="p-4 text-13 text-muted-foreground" role="status">
      {t(failed ? 'mailReader.failed' : 'mailReader.loading')}
      {failed && <Button variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>{t('mailReader.retry')}</Button>}
    </div>}
  </div>;
}
