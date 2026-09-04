import { useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { addBotProfileAndWait, type BotProfile } from './botStore';
import { BotBasicProfileFields, type BotBasicProfileValue } from './BotBasicProfileFields';
import { BotAvatar } from './BotAvatar';
import {
  BOT_TEMPLATE_CHOICES,
  CUSTOM_BOT_TEMPLATE_ID,
  getBotTemplate,
  getBotTemplateChoice,
  type BotTemplateChoiceId,
} from './botTemplates';

interface BotRosterViewProps {
  /** 创建成功后的落点。默认直接进 TA 的对话。 */
  onCreated?: (bot: BotProfile) => void;
}

/**
 * The only teammate creation surface. Templates fill this same basic profile
 * draft; they never branch into a second editor or expose runtime internals.
 */
export function BotRosterView({ onCreated }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [templateId, setTemplateId] = useState<BotTemplateChoiceId>('cindy');
  const initialTemplate = getBotTemplate('cindy');
  const [profile, setProfile] = useState<BotBasicProfileValue>(() => ({
    name: t('bots.createWizard.templates.cindy.defaultName'),
    description: t('bots.createWizard.templates.cindy.defaultDescription'),
    avatar: initialTemplate.avatar,
    avatarColor: initialTemplate.avatarColor,
  }));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = (id: BotTemplateChoiceId) => {
    const template = getBotTemplateChoice(id);
    setTemplateId(id);
    setProfile({
      name:
        id === CUSTOM_BOT_TEMPLATE_ID
          ? ''
          : t(`bots.createWizard.templates.${template.translationKey}.defaultName`),
      description:
        id === CUSTOM_BOT_TEMPLATE_ID
          ? ''
          : t(`bots.createWizard.templates.${template.translationKey}.defaultDescription`),
      avatar: template.avatar,
      avatarColor: template.avatarColor,
    });
    setError(null);
  };

  const handleCreated = (bot: BotProfile) => {
    if (onCreated) onCreated(bot);
    else navigate(`/bots/${bot.id}`);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = profile.name.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const template = getBotTemplateChoice(templateId);
      const bot = await addBotProfileAndWait({
        name,
        description: profile.description.trim(),
        identitySource: template.identitySource,
        userContextSource: '',
        avatar: profile.avatar,
        avatarColor: profile.avatarColor,
        welcomeMessage: t('bots.welcome.generic', { name }),
        skills: [],
        capabilities:
          template.toolsets.length > 0
            ? { toolsetMode: 'allowlist', toolsets: [...template.toolsets] }
            : undefined,
        ...(template.id === CUSTOM_BOT_TEMPLATE_ID ? {} : { templateId: template.id }),
      });
      handleCreated(bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('bots.createWizard.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-[var(--surface)]" role="main">
      <form
        className="mx-auto max-w-[720px] px-6 py-10 sm:px-8"
        onSubmit={(event) => void submit(event)}
      >
        <h1 className="text-24 font-medium text-[var(--text-primary)]">
          {t('bots.roster.customTitle')}
        </h1>
        <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
          {t('bots.createWizard.chooseTemplateDescription')}
        </p>

        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          {BOT_TEMPLATE_CHOICES.map((template) => {
            const selected = template.id === templateId;
            const key = template.translationKey;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => applyTemplate(template.id)}
                className={cn(
                  'flex min-h-36 min-w-0 flex-col rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-[var(--accent-cta-bg)] bg-[var(--surface-hover)]'
                    : 'border-[var(--border-default)] bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover)]',
                )}
                aria-pressed={selected}
              >
                <span className="flex w-full items-start justify-between gap-3">
                  <BotAvatar
                    bot={{
                      name: t(`bots.createWizard.templates.${key}.title`),
                      avatar: template.avatar,
                      avatarColor: template.avatarColor,
                    }}
                    size="sm"
                  />
                  {selected ? <Check size={15} className="text-[var(--accent-cta-bg)]" /> : null}
                </span>
                <span className="mt-3 text-14 font-medium text-[var(--text-primary)]">
                  {t(`bots.createWizard.templates.${key}.title`)}
                </span>
                <span className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                  {t(`bots.createWizard.templates.${key}.summary`)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <BotBasicProfileFields value={profile} onChange={(next) => setProfile(next)} />
        </div>

        <p className="mt-4 text-11 leading-4 text-[var(--text-tertiary)]">
          {t('bots.roster.customHint')}
        </p>
        {error ? (
          <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-7 flex justify-end">
          <button
            type="submit"
            disabled={creating || profile.name.trim().length === 0}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
          >
            {creating ? <Spinner size={14} /> : null}
            {t('bots.roster.create')}
          </button>
        </div>
      </form>
    </main>
  );
}
