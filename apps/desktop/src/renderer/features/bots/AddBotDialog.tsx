import { useEffect, useRef, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, Pencil, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { DEFAULT_CONTROL_BOT_EVENT_RULE } from '../../../shared/botSessionEvents';
import { addBotProfileAndWait, type BotProfile } from './botStore';
import {
  botAvatarAssignment,
  BotAvatarPicker,
  type BotAvatarAssignment,
  type BotAvatarHue,
} from './BotAvatar';
import {
  BOT_TEMPLATE_CHOICE_IDS,
  CUSTOM_BOT_TEMPLATE_ID,
  getBotTemplate,
  isBotTemplateId,
  type BotTemplateChoiceId,
} from './botTemplates';

interface AddBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (bot: BotProfile) => void;
}

/** i18n leaf for a template card; 'pr-steward' is camelCased in the catalog. */
function templateCopyKey(id: BotTemplateChoiceId): string {
  return id === 'pr-steward' ? 'prSteward' : id;
}

/**
 * Create a Bot in one screen: pick a card, keep or edit the name, hit create.
 *
 * Everything an ordinary user does not need to decide up front stays out:
 * harness, task control, event subscriptions and Channels are template
 * defaults, configurable afterwards in Bot settings. Only the blank "custom"
 * card asks for an identity, because there is no template text to inherit.
 */
export function AddBotDialog({ open, onOpenChange, onCreated }: AddBotDialogProps) {
  const { t } = useTranslation();
  const [templateId, setTemplateId] = useState<BotTemplateChoiceId>('control');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [identitySource, setIdentitySource] = useState('');
  const [identityOpen, setIdentityOpen] = useState(false);
  const [avatar, setAvatar] = useState('🤖');
  const [avatarColor, setAvatarColor] = useState<BotAvatarHue>('violet');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Auto-assigned mark for the blank card, refreshed on every dialog opening. */
  const autoAvatarRef = useRef<BotAvatarAssignment>({ emoji: '🤖', hue: 'violet' });

  const customSelected = templateId === CUSTOM_BOT_TEMPLATE_ID;

  const applyTemplate = (id: BotTemplateChoiceId, fallback: BotAvatarAssignment) => {
    setTemplateId(id);
    setError(null);
    if (!isBotTemplateId(id)) {
      setName('');
      setDescription('');
      setIdentitySource('');
      setAvatar(fallback.emoji);
      setAvatarColor(fallback.hue);
      // A blank identity has nothing to inherit, so the field must be visible.
      setIdentityOpen(true);
      return;
    }
    const next = getBotTemplate(id);
    setName(t(next.nameKey));
    setDescription(t(next.descriptionKey));
    setIdentitySource(next.identitySource);
    setAvatar(next.avatar);
    setAvatarColor(next.avatarColor);
    setIdentityOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    setCreating(false);
    // Every dialog opening gets a fresh good-looking avatar for the blank card;
    // template cards overwrite it with their own mark.
    autoAvatarRef.current = botAvatarAssignment(`${Date.now()}:${Math.random()}`);
    applyTemplate('control', autoAvatarRef.current);
    // The translation function changes with locale; opening the dialog is the
    // intentional point at which localized defaults are refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, t]);

  const submittable = name.trim().length > 0 && (!customSelected || identitySource.trim().length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!submittable || creating) return;
    setCreating(true);
    setError(null);
    try {
      const template = isBotTemplateId(templateId) ? getBotTemplate(templateId) : null;
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
        ...(template ? { capabilities: template.capabilities } : {}),
        ...(template?.autoSubscribeToTaskEvents
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(640px,calc(100vh-32px))] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-4 py-3">
            <div>
              <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
                {t('bots.addTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.createWizard.chooseTemplateDescription')}
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

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {BOT_TEMPLATE_CHOICE_IDS.map((id) => {
                  const selected = id === templateId;
                  const definition = isBotTemplateId(id) ? getBotTemplate(id) : null;
                  const copyKey = templateCopyKey(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => applyTemplate(id, autoAvatarRef.current)}
                      aria-pressed={selected}
                      className={cn(
                        'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors',
                        selected
                          ? 'border-[var(--text-primary)] bg-[var(--surface-hover)]'
                          : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                      )}
                    >
                      <span className="flex h-5 items-center justify-between gap-2">
                        {definition ? (
                          <span className="text-16" aria-hidden>
                            {definition.avatar}
                          </span>
                        ) : (
                          <Plus size={16} className="text-[var(--text-secondary)]" aria-hidden />
                        )}
                        {selected ? (
                          <Check size={14} className="text-[var(--text-primary)]" />
                        ) : null}
                      </span>
                      <span className="text-13 font-medium text-[var(--text-primary)]">
                        {t(`bots.createWizard.templates.${copyKey}.title`)}
                      </span>
                      <span className="text-11 leading-4 text-[var(--text-secondary)]">
                        {t(`bots.createWizard.templates.${copyKey}.summary`)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 flex items-end gap-3">
                <BotAvatarPicker
                  name={name}
                  avatar={avatar}
                  avatarColor={avatarColor}
                  onChange={(next) => {
                    setAvatar(next.emoji);
                    setAvatarColor(next.hue);
                  }}
                  triggerLabel={
                    <Pencil
                      size={10}
                      className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[var(--surface-elevated)] text-[var(--text-secondary)]"
                      aria-hidden
                    />
                  }
                />
                <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                  {t('bots.nameLabel')}
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('bots.namePlaceholder')}
                    className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                    required
                  />
                </label>
              </div>

              <label className="mt-3 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.descriptionLabel')}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('bots.descriptionPlaceholder')}
                  className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                />
              </label>

              <div className="mt-4 rounded-xl border border-[var(--border-default)]">
                <button
                  type="button"
                  onClick={() => setIdentityOpen((value) => !value)}
                  aria-expanded={identityOpen}
                  className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="min-w-0">
                    <span className="block text-12 font-medium text-[var(--text-primary)]">
                      {customSelected
                        ? t('bots.createWizard.identityRequiredLabel')
                        : t('bots.createWizard.identityOptionalLabel')}
                    </span>
                    <span className="mt-0.5 block text-11 leading-4 text-[var(--text-tertiary)]">
                      {customSelected
                        ? t('bots.createWizard.identityRequiredHint')
                        : t('bots.createWizard.identityOptionalHint')}
                    </span>
                  </span>
                  <ChevronDown
                    size={14}
                    className={cn(
                      'shrink-0 text-[var(--text-tertiary)] transition-transform',
                      identityOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>
                {identityOpen ? (
                  <div className="px-3 pb-3">
                    <textarea
                      value={identitySource}
                      onChange={(event) => setIdentitySource(event.target.value)}
                      rows={5}
                      aria-label={t('bots.createWizard.roleLabel')}
                      className="w-full resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 leading-5 text-[var(--text-primary)] outline-none focus:border-[var(--focus-ring)]"
                      required={customSelected}
                    />
                    <p className="mt-1.5 text-11 leading-4 text-[var(--text-tertiary)]">
                      {t('bots.createWizard.roleHint')}
                    </p>
                  </div>
                ) : null}
              </div>

              {error ? (
                <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3">
              <p className="min-w-0 text-11 leading-4 text-[var(--text-tertiary)]">
                {t('bots.createWizard.channelsHint')}
              </p>
              <button
                type="submit"
                disabled={creating || !submittable}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
              >
                {creating ? <Spinner size={14} /> : null}
                {creating ? t('bots.createWizard.creating') : t('bots.createWizard.submit')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
