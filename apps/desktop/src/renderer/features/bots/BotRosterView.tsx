import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';
import { BotImportForm } from './BotImportForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { normalizeBotName } from '../../../shared/botCreation';
import { BOT_PORTRAIT_COUNT, BotPortraitPicker, galleryPortrait } from './BotPortraitPicker';
import { addBotProfileAndWait, BotModelSelectionRequiredError, getEffectiveBotModelChain, subscribeBotGlobalModel, useBotProfiles, type BotProfile } from './botStore';
import { useProviders } from '@/hooks/useProviders';
import { BotModelChainEditor } from './BotModelChainEditor';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { Session } from '@/lib/ccAgent.types';
import { extractIpcError } from '@/utils/ipcError';

// Only the provider-setup detour retains a draft; ordinary close/unmount discards it.
let providerSetupDraft: {
  owner: DataOwnerGeneration;
  dataOwnerId: string | null;
  name: string;
  portrait?: string;
  initialPortrait: number;
  modelOverride: BotModelRoute[] | null;
  sourceTask?: Session;
  description?: string;
  requestId?: string;
} | null = null;

interface BotRosterViewProps {
  sourceTask?: Session;
  onCreated?: (bot: BotProfile) => void;
  onClose?: () => void;
  restoreFocus?: () => void;
  inline?: boolean;
}

/** A name creates a usable profile; identity and working habits develop in its own chat. */
export function BotRosterView({ onCreated, onClose, restoreFocus, inline = false, sourceTask: requestedSource }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  useProviders();
  useSyncExternalStore(subscribeBotGlobalModel, () => JSON.stringify(getEffectiveBotModelChain()));
  const [restoredDraft] = useState(() => providerSetupDraft
    && providerSetupDraft.dataOwnerId === dataOwnerId
    && (!requestedSource || requestedSource.id === providerSetupDraft.sourceTask?.id)
    && isDataOwnerGenerationCurrent(providerSetupDraft.owner) ? providerSetupDraft : null);
  const sourceTask = requestedSource ?? restoredDraft?.sourceTask;
  const remoteDeviceId = sourceTask?.deviceLinkDeviceId;
  const requestId = useRef(restoredDraft?.requestId);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { providerSetupDraft = null; }, []);
  const [modelOverride, setModelOverride] = useState<BotModelRoute[] | null>(restoredDraft ? restoredDraft.modelOverride : sourceTask ? [{
    harness: sourceTask.agentKind === 'cc' ? 'claude' : sourceTask.agentKind ?? 'claude',
    model: sourceTask.model, providerId: sourceTask.providerId ?? null,
    effort: sourceTask.effort ?? '', fastMode: sourceTask.fastMode,
  }] : null);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState(restoredDraft?.name ?? sourceTask?.title ?? '');
  const [description, setDescription] = useState(restoredDraft?.description ?? '');
  const [portrait, setPortrait] = useState<string | undefined>(restoredDraft?.portrait);
  const [initialPortrait] = useState(() => restoredDraft?.initialPortrait ?? Math.floor(Math.random() * BOT_PORTRAIT_COUNT));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void galleryPortrait(initialPortrait).then(value => {
      if (!cancelled) setPortrait(current => current ?? value);
    }).catch(() => { if (!cancelled) setError(t('bots.profile.avatarSelectionFailed')); });
    return () => { cancelled = true; alive.current = false; };
  }, [initialPortrait]);
  // A lost receipt may already have added this submission's profile to the roster.
  // Let the host resolve retries by request ID before checking a new name conflict.
  const duplicate = !(sourceTask && attempted) && !remoteDeviceId && bots.some(bot => bot.status !== 'archived' && normalizeBotName(bot.name) === normalizeBotName(name));
  const close = () => { if (onClose) onClose(); else navigate('/bots'); };
  const create = async () => {
    if (!name.trim() || duplicate || submitting.current || !portrait) return;
    const creationRequestId = sourceTask ? (requestId.current ??= crypto.randomUUID()) : undefined;
    submitting.current = true;
    setCreating(true);
    setAttempted(true);
    setError(null);
    try {
      if (remoteDeviceId && sourceTask) {
        const result = await window.electronAPI.deviceLink.invoke(remoteDeviceId, 'maker:task-companion',
          [{ action: 'create', sourceSessionId: sourceTask.id, requestId: creationRequestId, name: name.trim(), description }]) as { botId: string; sessionId: string };
        if (!alive.current) return;
        navigate(`/bots/remote/${encodeURIComponent(remoteDeviceId)}/${encodeURIComponent(result.botId)}/session/${encodeURIComponent(result.sessionId)}`);
        onClose?.();
        return;
      }
      const bot = await addBotProfileAndWait({ name: name.trim(), description,
        sourceSessionId: sourceTask?.id,
        ...(sourceTask ? { requestId: creationRequestId } : {}),
        ...(modelOverride ? { capabilities: { ...modelOverride[0], modelChain: modelOverride, modelChainOverride: modelOverride } } : {}),
        avatarImageBase64: portrait.split(',')[1], prepareInvitation: !sourceTask });
      if (!alive.current) return;
      if (onCreated) onCreated(bot); else navigate(`/bots/${bot.id}`);
      onClose?.();
    } catch (cause) {
      if (alive.current) setError(t(cause instanceof BotModelSelectionRequiredError
        ? 'bots.guided.modelRequired' : extractIpcError(cause)?.code === 'MODEL_SELECTION_UNAVAILABLE'
          ? 'ipcError.MODEL_SELECTION_UNAVAILABLE' : 'bots.createWizard.createFailed'));
    } finally {
      submitting.current = false;
      if (alive.current) setCreating(false);
    }
  };
  const title = t(importing ? 'bots.import.title' : 'bots.guided.title');
  const content = (
    <>
      <div className="mb-8 flex shrink-0 items-center justify-between gap-4">
        {inline ? (
          <h1 className="text-20 font-medium">{title}</h1>
        ) : (
          <Dialog.Title className="text-20 font-medium">{title}</Dialog.Title>
        )}
        {!inline && (
          <Button
            variant="secondary"
            size="lg"
            tone="quiet"
            type="button"
            onClick={close}
            disabled={creating}
          >
            {t('commonUi.confirmDialog.cancel')}
          </Button>
        )}
    </div>
    {importing ? <BotImportForm key={dataOwnerId} onBusy={setCreating} onBack={() => setImporting(false)} onCreated={botId => { const bot = bots.find(bot => bot.id === botId); if (onCreated && bot) onCreated(bot); else navigate(`/bots/${botId}`); onClose?.(); }} /> : <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="flex items-center gap-5">
        <BotPortraitPicker value={portrait} disabled={creating} onChange={setPortrait} />
        <label className="min-w-0 flex-1 text-13 text-[var(--text-secondary)]">
          {t('bots.creationName')}
          <input autoFocus value={name} maxLength={200} disabled={creating} onChange={event => setName(event.target.value)}
            className="mt-2 h-11 w-full rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] px-3 text-16 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" />
        </label>
      </div>
      {sourceTask && <div className="mt-5 text-13 text-[var(--text-secondary)]">
        <p>{t('bots.fromTask.explanation', { title: sourceTask.title })}</p>
        <label className="mt-4 block">{t('bots.fromTask.role')}
          <Input value={description} maxLength={4000} disabled={creating} onChange={setDescription}
            className="mt-2 h-11" />
        </label>
      </div>}
        {!remoteDeviceId && <div className="mt-5">
          <BotModelChainEditor
            label={t('bots.settingsTabs.model')}
            value={(modelOverride ?? getEffectiveBotModelChain()).slice(0, 1)}
            disabled={creating}
            allowFallbacks={false}
            onChange={(routes) => { setModelOverride(routes.slice(0, 1)); setError(null); }}
            onNavigateToProviders={() => {
              providerSetupDraft = { owner: getDataOwnerGeneration(), dataOwnerId, name, portrait, initialPortrait, modelOverride, sourceTask, description, requestId: requestId.current };
              navigate('/settings?tab=providers');
            }}
          />
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t(modelOverride ? 'bots.guided.modelForThisBot' : 'bots.guided.modelFollowsDefault')}
          </p>
        </div>
        }
        {(error || duplicate) && (
          <p role="alert" className="mt-4 text-13 text-[var(--text-danger)]">{duplicate ? t('bots.guided.duplicateName') : error}</p>
        )}
        <div className="mt-8 flex justify-between gap-3">
          {!sourceTask && <Button variant="secondary" size="lg" type="button" disabled={creating} onClick={() => setImporting(true)}>{t('bots.import.entry')}</Button>}
          <Button
            variant="cta"
            size="lg"
            loading={creating}
            type="submit"
            disabled={creating || !name.trim() || duplicate || !portrait}
          >
            {t('bots.guided.generate')}
            <ArrowRight size={16} />
          </Button>
      </div>
    </form>}
    </>
  );
  if (inline)
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] px-6 text-[var(--text-primary)]"><div className={importing ? "flex max-h-[90vh] w-full max-w-lg flex-col" : "w-full max-w-lg"}>{content}</div></main>
    );
  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !creating) close(); }}>
      <Dialog.Portal>
        {/* Keep portaled controls inside the overlay’s React tree so its scroll lock allows them. */}
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-50">
          <Dialog.Content aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()} onCloseAutoFocus={event => { if (restoreFocus) { event.preventDefault(); restoreFocus(); } }}
            className={`modal-panel fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 ${importing ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'} p-6 text-[var(--text-primary)] outline-none sm:p-8`}>
            {content}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
