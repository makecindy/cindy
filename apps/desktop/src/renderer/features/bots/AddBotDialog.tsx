import { useEffect, useMemo, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { DEFAULT_CONTROL_BOT_EVENT_RULE } from '../../../shared/botSessionEvents';
import { addBotProfileAndWait, useBotProfiles, type BotProfile } from './botStore';
import {
  BotAvatar,
  botAvatarAssignment,
  BotAvatarPicker,
  type BotAvatarAssignment,
  type BotAvatarHue,
} from './BotAvatar';
import { rememberPendingBotWelcome } from './botWelcome';
import {
  BOT_TEMPLATES,
  CUSTOM_BOT_TEMPLATE_ID,
  type BotTemplateDefinition,
} from './botTemplates';

interface AddBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (bot: BotProfile) => void;
  /** "Already have a teammate file?" — hands off to the existing import flow. */
  onImport?: () => void;
}

/**
 * Meet the roster.
 *
 * Picking a card *is* the creation: no name field, no description field, no
 * identity textarea. Everything a template already knows (voice, avatar,
 * capabilities, event subscription, greeting) comes with the character, and
 * anything an ordinary user does not need to decide up front — harness, task
 * control, Channels — stays a template default, configurable afterwards in the
 * teammate's own settings. Only the blank card asks anything, and only the two
 * things nobody can pick for you: a name and a face.
 */
export function AddBotDialog({ open, onOpenChange, onCreated, onImport }: AddBotDialogProps) {
  const { t } = useTranslation();
  const bots = useBotProfiles();
  const [view, setView] = useState<'roster' | 'custom'>('roster');
  const [customName, setCustomName] = useState('');
  const [customAvatar, setCustomAvatar] = useState<BotAvatarAssignment>({
    emoji: '🤖',
    hue: 'violet',
  });
  /** Which card is mid-flight — also the "one create at a time" latch. */
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setView('roster');
    setCustomName('');
    setCreatingId(null);
    setError(null);
    // Every dialog opening mints a fresh good-looking mark for the blank card.
    setCustomAvatar(botAvatarAssignment(`${Date.now()}:${Math.random()}`));
  }, [open]);

  // "Already joined" is matched on the displayed name: a Bot profile stores no
  // template id, and the name is exactly what the user recognizes on the card.
  // Archived teammates do not count — their card must be joinable again.
  const joinedNames = useMemo(() => {
    const names = new Set<string>();
    for (const bot of bots) {
      if (bot.status === 'archived') continue;
      const name = bot.name.trim().toLowerCase();
      if (name) names.add(name);
    }
    return names;
  }, [bots]);

  const isJoined = (template: BotTemplateDefinition) =>
    joinedNames.has(t(template.nameKey).trim().toLowerCase());

  const create = async (
    id: string,
    input: {
      name: string;
      description: string;
      identitySource: string;
      avatar: string;
      avatarColor: BotAvatarHue | string;
      template: BotTemplateDefinition | null;
    },
  ) => {
    if (creatingId) return;
    setCreatingId(id);
    setError(null);
    try {
      const bot = await addBotProfileAndWait({
        name: input.name,
        channel: 'local',
        description: input.description,
        identitySource: input.identitySource,
        // Hermes keeps USER context separate from SOUL. Templates do not
        // invent facts about the owner; users can add them in Bot Settings.
        userContextSource: '',
        avatar: input.avatar,
        avatarColor: input.avatarColor,
        skills: [],
        ...(input.template ? { capabilities: input.template.capabilities } : {}),
        ...(input.template?.autoSubscribeToTaskEvents
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
      // Park the greeting; the canonical chat delivers it on first open.
      if (input.template) rememberPendingBotWelcome(bot.id, input.template.welcomeKey);
      onOpenChange(false);
      onCreated(bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('bots.createWizard.createFailed'));
    } finally {
      setCreatingId(null);
    }
  };

  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    const name = customName.trim();
    if (!name) return;
    void create(CUSTOM_BOT_TEMPLATE_ID, {
      name,
      description: '',
      identitySource: '',
      avatar: customAvatar.emoji,
      avatarColor: customAvatar.hue,
      template: null,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,calc(100vh-32px))] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
                {view === 'custom' ? t('bots.roster.customTitle') : t('bots.roster.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {view === 'custom' ? t('bots.roster.customSubtitle') : t('bots.roster.subtitle')}
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

          {view === 'custom' ? (
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={submitCustom}>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                <div className="flex items-end gap-3">
                  <BotAvatarPicker
                    name={customName}
                    avatar={customAvatar.emoji}
                    avatarColor={customAvatar.hue}
                    onChange={setCustomAvatar}
                  />
                  <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                    {t('bots.roster.customNameLabel')}
                    <input
                      autoFocus
                      value={customName}
                      onChange={(event) => setCustomName(event.target.value)}
                      placeholder={t('bots.roster.customNamePlaceholder')}
                      className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                      required
                    />
                  </label>
                </div>
                <p className="mt-3 text-11 leading-4 text-[var(--text-tertiary)]">
                  {t('bots.roster.customHint')}
                </p>
                {error ? (
                  <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-[var(--border-default)] px-5 py-3">
                <button
                  type="button"
                  onClick={() => setView('roster')}
                  className="h-9 rounded-full px-4 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.roster.backToRoster')}
                </button>
                <button
                  type="submit"
                  disabled={creatingId !== null || customName.trim().length === 0}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
                >
                  {creatingId !== null ? <Spinner size={14} /> : null}
                  {t('bots.roster.join')}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  {BOT_TEMPLATES.map((template) => {
                    const joined = isJoined(template);
                    const name = t(template.nameKey);
                    return (
                      <div
                        key={template.id}
                        className={cn(
                          'flex flex-col rounded-xl border border-[var(--border-default)] p-4',
                          joined && 'opacity-60',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <BotAvatar
                            bot={{
                              name,
                              avatar: template.avatar,
                              avatarColor: template.avatarColor,
                            }}
                            size="xl"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-14 font-medium text-[var(--text-primary)]">
                              {name}
                            </p>
                            <p className="mt-0.5 truncate text-11 text-[var(--text-tertiary)]">
                              {t('bots.roster.goodAt', { skill: t(template.skillKey) })}
                            </p>
                          </div>
                        </div>
                        <p className="mt-3 min-h-[60px] flex-1 text-12 leading-5 text-[var(--text-secondary)]">
                          {t(template.introKey)}
                        </p>
                        <button
                          type="button"
                          disabled={joined || creatingId !== null}
                          onClick={() =>
                            void create(template.id, {
                              name,
                              description: t(template.descriptionKey),
                              identitySource: template.identitySource,
                              avatar: template.avatar,
                              avatarColor: template.avatarColor,
                              template,
                            })
                          }
                          className={cn(
                            'mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-full text-12 font-medium transition-opacity',
                            joined
                              ? 'cursor-default border border-[var(--border-default)] text-[var(--text-tertiary)]'
                              : 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50',
                          )}
                        >
                          {creatingId === template.id ? <Spinner size={14} /> : null}
                          {joined ? t('bots.roster.joined') : t('bots.roster.join')}
                        </button>
                      </div>
                    );
                  })}

                  <div className="flex flex-col rounded-xl border border-dashed border-[var(--border-default)] p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)]">
                        <Plus size={22} aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-14 font-medium text-[var(--text-primary)]">
                          {t('bots.roster.customName')}
                        </p>
                        <p className="mt-0.5 truncate text-11 text-[var(--text-tertiary)]">
                          {t('bots.roster.goodAt', { skill: t('bots.roster.customSkill') })}
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 min-h-[60px] flex-1 text-12 leading-5 text-[var(--text-secondary)]">
                      {t('bots.roster.customIntro')}
                    </p>
                    <button
                      type="button"
                      onClick={() => setView('custom')}
                      className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-full border border-[var(--border-default)] text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    >
                      {t('bots.roster.customAction')}
                    </button>
                  </div>
                </div>

                {error ? (
                  <p className="mt-4 text-12 text-[var(--text-danger)]" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-2 border-t border-[var(--border-default)] px-5 py-3">
                <p className="text-11 leading-4 text-[var(--text-tertiary)]">
                  {t('bots.roster.footerHint')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onImport?.();
                  }}
                  className="w-fit rounded-lg text-11 text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
                >
                  {t('bots.roster.importLink')}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
