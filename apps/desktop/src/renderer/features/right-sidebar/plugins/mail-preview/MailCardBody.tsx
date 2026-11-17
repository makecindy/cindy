import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { readMailCard } from '@cindy/maker-shared/ghost-card-form';
import { ensureRemoteCard, getGhostCardSnapshot, retainRemoteCardSession, subscribeGhostCards } from '@/cindy-brain/ghostCardStore';
import { MailCardEditor } from '@/components/chat/GhostToolCard';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import type { TabKindBodyProps } from '../../types';

type Card = { callId: string; ghostId: string; html: string; height: number };

/** Resolve only within this task. Persisted tab state contains an ID, never mail text.
 * A remote task's cards are read through its computer (ghostCardStore), and the editor's actions
 * go there as well. */
export function MailCardBody({ state, ctx }: TabKindBodyProps<{ callId: string }>) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribeGhostCards, getGhostCardSnapshot);
  const owner = getDataOwnerGeneration();
  const binding = JSON.stringify([owner, ctx.sessionId, ctx.deviceLinkDeviceId, state.callId]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ binding: string; cards: Card[]; requested?: string; error?: boolean }>();
  const remoteDevice = ctx.deviceLinkDeviceId || undefined;
  const rows: Card[] = remoteDevice
    ? [...snapshot.byCallId].flatMap(([callId, entry]) => entry.status === 'ready' && entry.remote?.deviceId === remoteDevice && entry.remote.sessionId === ctx.sessionId
      ? [{ callId, ghostId: entry.ghostId, html: entry.html, height: entry.height }] : [])
    : result?.binding === binding ? result.cards : [];
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
  useEffect(() => remoteDevice ? retainRemoteCardSession(remoteDevice, ctx.sessionId) : undefined, [remoteDevice, ctx.sessionId]);
  useEffect(() => {
    if (!remoteDevice) return;
    ensureRemoteCard(remoteDevice, ctx.sessionId, state.callId, { force: attempt > 0 });
    if (missing) ensureRemoteCard(remoteDevice, ctx.sessionId, missing, { force: attempt > 0 });
  }, [remoteDevice, ctx.sessionId, state.callId, missing, attempt]);
  useEffect(() => {
    let active = true;
    // Never resolve a remote task's ID among this computer's cards.
    if (ctx.deviceLinkDeviceId === undefined || remoteDevice) return;
    void window.electronAPI.ghosts.listCardsBySession(ctx.sessionId).then(({ cards }) => {
      if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, cards, requested: missing });
    }).catch(() => { if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, cards: [], requested: missing, error: true }); });
    return () => { active = false; };
  }, [binding, missing, attempt]);
  const remoteFailed = (callId: string) => snapshot.byCallId.get(callId)?.status === 'missing';
  // Remote: the newest card could not be read, or the card that was read is not a usable mail card.
  const failed = !current && (remoteDevice
    ? missing ? remoteFailed(missing) : rows.some(c => c.callId === state.callId) || remoteFailed(state.callId)
    : result?.binding === binding && (!missing || result.requested === missing));
  return <div className="h-full overflow-auto">
    {current ? <ChatSessionFileProvider value={{ sessionId: ctx.sessionId, workingDir: ctx.workdir, origin: remoteDevice ? { kind: 'device', deviceId: remoteDevice } : { kind: 'local' } }}>
      <article className="mx-auto max-w-[960px] px-1 py-2" data-mail-panel-call-id={current.callId}>
        <MailCardEditor key={`${binding}:${current.callId}`} callId={current.callId} html={current.html} height={current.height} sessionId={ctx.sessionId} />
      </article>
    </ChatSessionFileProvider> : <div className="p-4 text-13 text-muted-foreground" role="status">
      {t(failed ? 'mailReader.failed' : 'mailReader.loading')}
      {failed && <Button variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>{t('mailReader.retry')}</Button>}
    </div>}
  </div>;
}
