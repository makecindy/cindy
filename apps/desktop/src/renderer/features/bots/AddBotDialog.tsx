import { useEffect, useMemo, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { BellRing, Bot, Check, ChevronLeft, Clock3, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { DEFAULT_CONTROL_BOT_EVENT_RULE } from '../../../shared/botSessionEvents';
import { addBotProfileAndWait, type BotProfile } from './botStore';
import { BOT_TEMPLATES, getBotTemplate, type BotTemplateId } from './botTemplates';

const AVATARS = ['🧭', '🛠️', '✦', '🤖', '📡', '☄️'];
const AVATAR_COLORS = ['violet', 'blue', 'amber', 'graphite'] as const;
const AVATAR_COLOR_STYLES: Record<(typeof AVATAR_COLORS)[number], string> = {
  violet: 'var(--accent-cta-bg)',
  blue: 'var(--focus-ring-soft)',
  amber: 'var(--text-secondary)',
  graphite: 'var(--text-primary)',
};

interface AddBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (bot: BotProfile) => void;
}

export function AddBotDialog({ open, onOpenChange, onCreated }: AddBotDialogProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'template' | 'identity'>('template');
  const [templateId, setTemplateId] = useState<BotTemplateId>('control');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [identitySource, setIdentitySource] = useState('');
  const [avatar, setAvatar] = useState('🧭');
  const [avatarColor, setAvatarColor] = useState<(typeof AVATAR_COLORS)[number]>('violet');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = useMemo(() => getBotTemplate(templateId), [templateId]);

  const applyTemplate = (id: BotTemplateId) => {
    const next = getBotTemplate(id);
    setTemplateId(id);
    setName(t(next.nameKey));
    setDescription(t(next.descriptionKey));
    setIdentitySource(next.identitySource);
    setAvatar(next.avatar);
    setAvatarColor(next.avatarColor);
    setError(null);
  };

  useEffect(() => {
    if (!open) return;
    setStep('template');
    setCreating(false);
    applyTemplate('control');
    // The translation function changes with locale; opening the wizard is the
    // intentional point at which localized defaults are refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, t]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !identitySource.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const bot = await addBotProfileAndWait({
        name,
        channel: 'local',
        description,
        identitySource,
        // Hermes keeps USER context separate from SOUL. Templates do not
        // invent facts about the owner; users can add them in Bot Settings.
        userContextSource: '',
        avatar,
        avatarColor,
        skills: [],
        capabilities: template.capabilities,
        ...(template.autoSubscribeToTaskEvents
          ? {
              eventSubscription: {
                id: 'control-events',
                name: t('bots.inbox.defaultSubscriptionName'),
                status: 'active' as const,
                rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
              },
            }
          : {}),
      });
      onOpenChange(false);
      onCreated(bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('bots.createWizard.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(760px,calc(100vh-32px))] w-[min(760px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-5 py-4">
            <div>
              <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
                {t('bots.addTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {step === 'template'
                  ? t('bots.createWizard.chooseTemplateDescription')
                  : t('bots.createWizard.identityDescription')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-lg p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"
                aria-label={t('bots.close')}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <form className="min-h-0 flex-1 overflow-y-auto p-5" onSubmit={submit}>
            {step === 'template' ? (
              <div>
                <div className="grid gap-3 md:grid-cols-3">
                  {BOT_TEMPLATES.map((item, index) => {
                    const selected = item.id === templateId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => applyTemplate(item.id)}
                        className={cn(
                          'flex min-h-44 flex-col rounded-xl border p-4 text-left transition-colors',
                          selected
                            ? 'border-[var(--accent-cta-bg)] bg-[var(--surface-hover)]'
                            : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                        )}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="text-24" aria-hidden>
                            {item.avatar}
                          </span>
                          {index === 0 ? (
                            <span className="rounded-full bg-[var(--accent-soft-bg)] px-2 py-1 text-10 font-medium text-[var(--accent-soft-fg)]">
                              {t('bots.createWizard.recommended')}
                            </span>
                          ) : selected ? (
                            <Check size={15} className="text-[var(--accent-cta-bg)]" />
                          ) : null}
                        </span>
                        <span className="mt-4 text-14 font-medium text-[var(--text-primary)]">
                          {t(
                            `bots.createWizard.templates.${item.id === 'pr-steward' ? 'prSteward' : item.id}.title`,
                          )}
                        </span>
                        <span className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                          {t(
                            `bots.createWizard.templates.${item.id === 'pr-steward' ? 'prSteward' : item.id}.summary`,
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-5 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-4">
                  <p className="text-12 font-medium text-[var(--text-primary)]">
                    {t('bots.createWizard.profileSeparationTitle')}
                  </p>
                  <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                    {t('bots.createWizard.profileSeparationDescription')}
                  </p>
                </div>

                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setStep('identity')}
                    className="h-9 rounded-lg bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90"
                  >
                    {t('bots.createWizard.continue')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="flex min-w-0 flex-col gap-4">
                  <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                    {t('bots.nameLabel')}
                    <input
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                    {t('bots.descriptionLabel')}
                    <input
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                    />
                  </label>

                  <fieldset>
                    <legend className="text-12 text-[var(--text-secondary)]">
                      {t('bots.createWizard.avatarLabel')}
                    </legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {AVATARS.map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setAvatar(item)}
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg border text-base',
                            avatar === item
                              ? 'border-[var(--accent-cta-bg)] bg-[var(--surface-hover)]'
                              : 'border-[var(--border-default)]',
                          )}
                          aria-label={t('bots.chooseAvatar', { avatar: item })}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      {AVATAR_COLORS.map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setAvatarColor(item)}
                          className={cn(
                            'h-6 w-6 rounded-full border border-[var(--border-default)]',
                            avatarColor === item && 'ring-2 ring-[var(--focus-ring-soft)]',
                          )}
                          style={{ backgroundColor: AVATAR_COLOR_STYLES[item] }}
                          aria-label={t('bots.chooseAvatarColor', { color: item })}
                        />
                      ))}
                    </div>
                  </fieldset>

                  <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                    {t('bots.createWizard.roleLabel')}
                    <textarea
                      value={identitySource}
                      onChange={(event) => setIdentitySource(event.target.value)}
                      rows={7}
                      className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 leading-5 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                      required
                    />
                    <span className="text-11 leading-5 text-[var(--text-tertiary)]">
                      {t('bots.createWizard.roleHint')}
                    </span>
                  </label>
                </div>

                <aside className="rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-4">
                  <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
                    <Sparkles size={15} />
                    {t('bots.createWizard.recommendedConfiguration')}
                  </div>
                  <dl className="mt-4 flex flex-col gap-3 text-12">
                    <div>
                      <dt className="text-[var(--text-tertiary)]">
                        {t('bots.createWizard.localProfile')}
                      </dt>
                      <dd className="mt-0.5 text-[var(--text-primary)]">
                        {t('bots.createWizard.localProfileValue')}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-tertiary)]">{t('bots.harnessLabel')}</dt>
                      <dd className="mt-0.5 text-[var(--text-primary)]">
                        {t('bots.createWizard.currentHarness')}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-tertiary)]">
                        {t('bots.sessionControl.title')}
                      </dt>
                      <dd className="mt-0.5 text-[var(--text-primary)]">
                        {t(
                          `bots.sessionControl.${template.capabilities.sessionControlMode ?? 'none'}`,
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="flex items-center gap-2 text-[var(--text-secondary)]">
                        <Clock3 size={13} />
                        {t('bots.automationLabel')}
                      </dt>
                      <dd>
                        {template.capabilities.automation
                          ? t('bots.createWizard.enabled')
                          : t('bots.createWizard.notEnabled')}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="flex items-center gap-2 text-[var(--text-secondary)]">
                        <BellRing size={13} />
                        {t('bots.createWizard.taskEvents')}
                      </dt>
                      <dd>
                        {template.autoSubscribeToTaskEvents
                          ? t('bots.createWizard.automatic')
                          : t('bots.createWizard.notEnabled')}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 text-11 leading-5 text-[var(--text-tertiary)]">
                    {t('bots.createWizard.channelsLater')}
                  </p>
                </aside>

                {error ? (
                  <p className="text-12 text-[var(--text-danger)] lg:col-span-2" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="flex items-center justify-between gap-3 lg:col-span-2">
                  <button
                    type="button"
                    onClick={() => setStep('template')}
                    className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                  >
                    <ChevronLeft size={14} />
                    {t('bots.createWizard.back')}
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !name.trim() || !identitySource.trim()}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50"
                  >
                    <Bot size={14} />
                    {creating ? t('bots.createWizard.creating') : t('bots.create')}
                  </button>
                </div>
              </div>
            )}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
