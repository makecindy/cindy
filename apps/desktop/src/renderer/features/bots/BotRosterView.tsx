import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BotInvitationWelcome } from './BotInvitationWelcome';
import { Spinner } from '@/components/ui/spinner';
import { BOT_AVATAR_MAX_BYTES } from '../../../shared/botAvatarValue';
import {
  addBotProfileAndWait,
  refreshBotProfiles,
  useBotProfiles,
  type BotProfile,
} from './botStore';
import { BotBasicProfileFields, type BotBasicProfileValue } from './BotBasicProfileFields';
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
  onClose?: () => void;
  restoreFocus?: () => void;
}

/**
 * The only teammate creation surface. Templates fill this same basic profile
 * draft; they never branch into a second editor or expose runtime internals.
 */
export function BotRosterView({ onCreated, onClose, restoreFocus }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const [invited, setInvited] = useState<BotProfile | null>(null);
  useEffect(() => {
    if (!invited) return;
    const unsubscribe = window.electronAPI?.maker?.onBotProfileChanged?.(() =>
      refreshBotProfiles(),
    );
    refreshBotProfiles();
    return unsubscribe;
  }, [invited?.id]);
  const invitedBot = bots.find((bot) => bot.id === invited?.id) ?? invited;
  useEffect(() => {
    if (invitedBot?.invitation?.stage === 'ready') {
      if (onCreated) onCreated(invitedBot);
      else navigate(`/bots/${invitedBot.id}`);
      onClose?.();
    }
  }, [invitedBot, navigate, onCreated, onClose]);
  const [templateId, setTemplateId] = useState<BotTemplateChoiceId>('cindy');
  const initialTemplate = getBotTemplate('cindy');
  const [profile, setProfile] = useState<BotBasicProfileValue & { avatarData?: string }>(() => ({
    name: t('bots.createWizard.templates.cindy.defaultName'),
    description: t('bots.createWizard.templates.cindy.defaultDescription'),
    avatar: initialTemplate.avatar,
    avatarColor: initialTemplate.avatarColor,
  }));
  const fileInput = useRef<HTMLInputElement>(null);
  const reader = useRef<FileReader | null>(null);
  const drafts = useRef<Partial<Record<BotTemplateChoiceId, typeof profile>>>({});
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  useEffect(() => () => reader.current?.abort(), []);
  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setAvatarError(false);
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      !file.size ||
      file.size > BOT_AVATAR_MAX_BYTES
    ) {
      setAvatarError(true);
      return;
    }
    setAvatarBusy(true);
    const pending = new FileReader();
    reader.current = pending;
    pending.onload = () => {
      setProfile((current) => ({ ...current, avatarData: String(pending.result) }));
      setAvatarBusy(false);
    };
    pending.onerror = () => {
      setAvatarError(true);
      setAvatarBusy(false);
    };
    pending.readAsDataURL(file);
  };
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = (id: BotTemplateChoiceId) => {
    if (id === templateId) return;
    drafts.current[templateId] = profile;
    const template = getBotTemplateChoice(id);
    setTemplateId(id);
    setProfile(
      drafts.current[id] ?? {
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
      },
    );
    setError(null);
    setAvatarError(false);
  };

  const handleCreated = (bot: BotProfile) => {
    if (onCreated) onCreated(bot);
    else navigate(`/bots/${bot.id}`);
    onClose?.();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = profile.name.trim();
    if (!name || creating || avatarBusy) return;
    setCreating(true);
    setError(null);
    try {
      const template = getBotTemplateChoice(templateId);
      const bot = await addBotProfileAndWait({
        name,
        prepareInvitation: true,
        description: profile.description.trim(),
        identitySource: template.identitySource,
        userContextSource: '',
        avatar: profile.avatar,
        ...(profile.avatarData ? { avatarImageBase64: profile.avatarData.split(',')[1] } : {}),
        avatarColor: profile.avatarColor,
        skills: [],
        capabilities:
          template.toolsets.length > 0
            ? { toolsetMode: 'allowlist', toolsets: [...template.toolsets] }
            : undefined,
        ...(template.id !== CUSTOM_BOT_TEMPLATE_ID &&
        profile.description.trim() ===
          t(`bots.createWizard.templates.${template.translationKey}.defaultDescription`).trim()
          ? { templateId: template.id }
          : {}),
      });
      if (bot.invitation && bot.invitation.stage !== 'ready') setInvited(bot);
      else handleCreated(bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('bots.createWizard.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const close = () => {
    if (creating) return;
    if (onClose) onClose();
    else navigate('/bots');
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (restoreFocus) {
              event.preventDefault();
              restoreFocus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-5 outline-none"
        >
          {invitedBot ? (
            <>
              <Dialog.Title className="sr-only">{t('bots.invitation.title')}</Dialog.Title>
              <BotInvitationWelcome bot={invitedBot} />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={close}
                  className="h-9 rounded-full px-4 text-13 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.invitation.leave')}
                </button>
              </div>
            </>
          ) : (
            <form className="min-w-0" onSubmit={(event) => void submit(event)}>
              <Dialog.Title className="text-20 font-medium text-[var(--text-primary)]">
                {t('bots.roster.customTitle')}
              </Dialog.Title>
              <fieldset
                disabled={creating || avatarBusy}
                className="mt-6 min-w-0 space-y-6 disabled:opacity-70"
              >
                <label className="block text-12 text-[var(--text-secondary)]">
                  {t('bots.createWizard.chooseTemplate')}
                  <span className="relative mt-1.5 block">
                    <select
                      value={templateId}
                      onChange={(event) => applyTemplate(event.target.value as BotTemplateChoiceId)}
                      className="h-10 w-full appearance-none rounded-full border border-[var(--border-default)] bg-[var(--surface)] pl-4 pr-10 text-14 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      {BOT_TEMPLATE_CHOICES.map((template) => (
                        <option key={template.id} value={template.id}>
                          {t(`bots.createWizard.templates.${template.translationKey}.title`)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className="pointer-events-none absolute right-4 top-3 text-[var(--text-secondary)]"
                    />
                  </span>
                </label>
                <BotBasicProfileFields
                  autoFocusName
                  value={profile}
                  onChange={(next) => setProfile((current) => ({ ...current, ...next }))}
                  onChooseAvatar={() => fileInput.current?.click()}
                  avatarBusy={avatarBusy}
                  avatarPreview={profile.avatarData}
                />
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  aria-label={t('bots.profile.changeAvatar')}
                  onChange={chooseAvatar}
                />
              </fieldset>
              {avatarError ? (
                <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
                  {t('bots.profile.avatarSelectionFailed')}
                </p>
              ) : null}

              {error ? (
                <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={creating}
                  onClick={close}
                  className="h-9 rounded-full border border-[var(--border-default)] px-5 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                >
                  {t('commonUi.confirmDialog.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={creating || avatarBusy || profile.name.trim().length === 0}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
                >
                  {creating ? <Spinner size={14} /> : null}
                  {t('bots.roster.create')}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
