import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type MailMessage, type MailReaderChoice } from '@cindy/maker-shared/mail-message';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';
import { readMailPreview } from '../../lib/mailPreview';
import { MailCardBody } from './MailCardBody';
import { MailConversationView } from './MailConversationView';

type State = { url: string; callId?: string };
export function MailPreviewBody({ state, ctx, active: tabActive = true, shellVisible = true }: TabKindBodyProps<State>) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ binding: string; message?: MailMessage; draftCallId?: string; error?: boolean; unavailable?: 'unavailable' | 'notReady'; providerId?: string; providers?: MailReaderChoice[] }>();
  const owner = getDataOwnerGeneration();
  const scope = JSON.stringify([owner, ctx.sessionId, ctx.deviceLinkDeviceId, state.url]);
  const [selection, setSelection] = useState<{ scope: string; id: string }>();
  const selected = selection?.scope === scope ? selection.id : undefined;
  const binding = JSON.stringify([scope, attempt, selected]);
  const visible = tabActive && shellVisible;
  useEffect(() => {
    let active = true;
    if (!visible || ctx.deviceLinkDeviceId === undefined) return;
    void readMailPreview(ctx.sessionId, state.url, true, ctx.deviceLinkDeviceId, true, selected).then(r => {
      if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, message: r.message ?? undefined, draftCallId: r.draftCallId, error: !r.message,
        unavailable: r.supported === false ? 'unavailable' : r.error === 'MAIL_PROVIDER_NOT_READY' ? 'notReady' : undefined,
        providerId: r.providerId, providers: r.providers });
    }).catch(() => { if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, error: true }); });
    return () => { active = false; };
  }, [binding, visible]);
  const current = result?.binding === binding ? result : undefined;
  const mail = current?.message;
  const read = useCallback(async (url: string, opened = false) => {
    const response = await readMailPreview(ctx.sessionId, url || state.url, true, ctx.deviceLinkDeviceId, opened && visible, current?.providerId);
    return isDataOwnerGenerationCurrent(owner) ? response : { message: null };
  }, [owner, ctx.sessionId, ctx.deviceLinkDeviceId, state.url, visible, current?.providerId]);
  const openMailbox = <Button tone="quiet" compact size="sm" aria-label={t('mailReader.openMailbox')} title={t('mailReader.openMailbox')}
    onClick={() => { void window.electronAPI.openExternal(state.url); }}><ExternalLink className="h-4 w-4" /></Button>;
  // The local editor dispatches local card actions. Remote Desktop keeps the
  // readable message and original mailbox link until that editor supports peers.
  if (current?.draftCallId && ctx.deviceLinkDeviceId === null) return <MailCardBody ctx={ctx} state={{ callId: current.draftCallId }} />;
  return <div className="h-full min-h-0">
    {mail ? <ChatSessionFileProvider value={{ sessionId: ctx.sessionId, workingDir: ctx.workdir, origin: ctx.deviceLinkDeviceId ? { kind: 'device', deviceId: ctx.deviceLinkDeviceId } : { kind: 'local' } }}>
      <MailConversationView key={binding} mail={mail} openMailbox={openMailbox} read={read} retry={() => setAttempt(n => n + 1)} />
    </ChatSessionFileProvider> : <div className="p-4 text-13 text-muted-foreground" role="status">
      {(!current?.error || !!current.providers?.length) && <div className="mb-3 flex justify-end">{openMailbox}</div>}
      {current?.providers?.length ? <div className="space-y-3">
        <p>{t('mailReader.choosePlugin')}</p>
        <div className="flex flex-col items-start gap-2">{current.providers.map(p => <Button key={p.id} variant="secondary" size="sm" className="h-auto max-w-full whitespace-normal break-words text-left"
          onClick={() => setSelection({ scope, id: p.id })}>{p.name} · {p.namespace || t('mailReader.personalPlugin')}</Button>)}</div>
      </div> : <>{t(current?.unavailable ? `mailReader.${current.unavailable}` : current?.error ? 'mailReader.failed' : 'mailReader.loading')}
        {current?.error && <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => { void window.electronAPI.openExternal(state.url); }}><ExternalLink className="h-4 w-4" />{t('mailReader.openMailbox')}</Button>
          {!current.unavailable && <Button variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>{t('mailReader.retry')}</Button>}
        </div>}</>}
    </div>}
  </div>;
}
const plugin: TabKindPlugin<State> = {
  kind: 'mail-preview', menu: { kind: 'mail-preview', labelKey: 'mailReader.title', icon: Mail, order: 20, enabled: true, hiddenFromMenu: true, singleton: true },
  TabPillTitle: ({ t }) => <>{t('mailReader.title')}</>, TabPillIcon: () => <Mail size={13} />,
  TabBody: (props: TabKindBodyProps<State>) => props.state.callId ? <MailCardBody {...props} state={{ callId: props.state.callId }} /> : <MailPreviewBody {...props} />,
  defaultState: () => ({ url: '' }),
  hydrateState: raw => ({ url: typeof (raw as State)?.url === 'string' ? (raw as State).url : '',
    ...(typeof (raw as State)?.callId === 'string' && (raw as State).callId!.length <= 128 ? { callId: (raw as State).callId } : {}) }),
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
