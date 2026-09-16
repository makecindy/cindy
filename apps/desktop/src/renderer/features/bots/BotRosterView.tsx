import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { normalizeBotName } from '../../../shared/botCreation';
import { Spinner } from '@/components/ui/spinner';
import { BotPortraitPicker, galleryPortrait } from './BotPortraitPicker';
import { addBotProfileAndWait, BotModelSelectionRequiredError, useBotProfiles, type BotProfile } from './botStore';

interface BotRosterViewProps {
  onCreated?: (bot: BotProfile) => void;
  onClose?: () => void;
  restoreFocus?: () => void;
  inline?: boolean;
}

/** A name creates a usable profile; identity and working habits develop in its own chat. */
export function BotRosterView({ onCreated, onClose, restoreFocus, inline = false }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const [name, setName] = useState('');
  const [portrait, setPortrait] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void galleryPortrait(bots.length % 16).then(value => {
      if (!cancelled) setPortrait(current => current ?? value);
    }).catch(() => { if (!cancelled) setError(t('bots.profile.avatarSelectionFailed')); });
    return () => { cancelled = true; alive.current = false; };
  }, []);
  const duplicate = bots.some(bot => bot.status !== 'archived' && normalizeBotName(bot.name) === normalizeBotName(name));
  const close = () => { if (onClose) onClose(); else navigate('/bots'); };
  const create = async () => {
    if (!name.trim() || duplicate || submitting.current || !portrait) return;
    submitting.current = true;
    setCreating(true);
    setError(null);
    try {
      const bot = await addBotProfileAndWait({ name: name.trim(), description: '',
        avatarImageBase64: portrait.split(',')[1], prepareInvitation: true });
      if (!alive.current) return;
      if (onCreated) onCreated(bot); else navigate(`/bots/${bot.id}`);
      onClose?.();
    } catch (cause) {
      if (alive.current) setError(t(cause instanceof BotModelSelectionRequiredError
        ? 'bots.guided.modelRequired' : 'bots.createWizard.createFailed'));
    } finally {
      submitting.current = false;
      if (alive.current) setCreating(false);
    }
  };
  const title = t('bots.guided.title');
  const content = <>
    <div className="mb-8 flex items-center justify-between gap-4">
      {inline ? <h1 className="text-20 font-medium">{title}</h1> : <Dialog.Title className="text-20 font-medium">{title}</Dialog.Title>}
      {!inline && <button type="button" onClick={close} disabled={creating} className="h-9 rounded-full px-4 text-13 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{t('commonUi.confirmDialog.cancel')}</button>}
    </div>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="flex items-center gap-5">
        <BotPortraitPicker value={portrait} disabled={creating} onChange={setPortrait} />
        <label className="min-w-0 flex-1 text-13 text-[var(--text-secondary)]">
          {t('bots.creationName')}
          <input autoFocus value={name} maxLength={200} disabled={creating} onChange={event => setName(event.target.value)}
            className="mt-2 h-11 w-full rounded-lg border border-[var(--border-default)] bg-[var(--confirm-bg)] px-3 text-16 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" />
        </label>
      </div>
      {(error || duplicate) && <p role="alert" className="mt-4 text-13 text-[var(--text-danger)]">{duplicate ? t('bots.guided.duplicateName') : error}</p>}
      {error === t('bots.guided.modelRequired') && <button type="button" className="mt-3 h-9 rounded-full px-4 text-13 hover:bg-[var(--surface-hover)]" onClick={() => navigate('/settings?tab=providers')}>{t('bots.settingsTabs.model')}</button>}
      <div className="mt-8 flex justify-end">
        <button type="submit" disabled={creating || !name.trim() || duplicate || !portrait}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-13 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50">
          {creating ? <Spinner size={14} /> : null}{t('bots.guided.generate')}<ArrowRight size={16} />
        </button>
      </div>
    </form>
  </>;
  if (inline) return <main className="flex h-full items-center justify-center bg-[var(--surface)] px-6 text-[var(--text-primary)]"><div className="w-full max-w-lg">{content}</div></main>;
  return <Dialog.Root open onOpenChange={open => { if (!open && !creating) close(); }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
    <Dialog.Content aria-describedby={undefined} onCloseAutoFocus={event => { if (restoreFocus) { event.preventDefault(); restoreFocus(); } }}
      className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-6 text-[var(--text-primary)] outline-none sm:p-8">
      {content}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
