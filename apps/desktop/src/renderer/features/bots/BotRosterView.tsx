import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { addBotProfileAndWait, type BotProfile } from './botStore';
import { BotAvatar, botAvatarAssignment, type BotAvatarAssignment } from './BotAvatar';
import { rememberPendingBotWelcome } from './botWelcome';

/**
 * 创建伙伴。
 *
 * 阵容页原来的模板卡与「AI 起草」路径已经拿掉:伙伴画像收敛成「名字 + 色相头像 +
 * 人设文本」,创建时只问用户自己才知道的事 —— 名字、简介、背景与性格。头像随名字
 * 的哈希自动定色,创建时不再手选。
 */
interface BotRosterViewProps {
  /** 创建成功后的落点。默认直接进 TA 的对话。 */
  onCreated?: (bot: BotProfile) => void;
}

export function BotRosterView({ onCreated }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [customName, setCustomName] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [customIdentity, setCustomIdentity] = useState('');
  const [customPersonality, setCustomPersonality] = useState('');
  const [customAvatar] = useState<BotAvatarAssignment>(() =>
    botAvatarAssignment(`${Date.now()}:${Math.random()}`),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreated = (bot: BotProfile) => {
    if (onCreated) {
      onCreated(bot);
      return;
    }
    navigate(`/bots/${bot.id}`);
  };

  const submitCustom = async (event: FormEvent) => {
    event.preventDefault();
    const name = customName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const bot = await addBotProfileAndWait({
        name,
        channel: 'local',
        description: customDescription.trim(),
        identitySource: [customIdentity.trim(), customPersonality.trim()]
          .filter(Boolean)
          .join('\n\n'),
        // Hermes keeps USER context separate from SOUL. 手捏伙伴不预先假设
        // 关于主人的任何事,用户可以之后在 Bot Settings 里自己补。
        userContextSource: '',
        avatar: customAvatar.emoji,
        avatarColor: customAvatar.hue,
        skills: [],
      });
      // Park the greeting; the canonical chat delivers it on first open.
      rememberPendingBotWelcome(bot.id, {
        key: 'bots.welcome.generic',
        params: { name },
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
        className="mx-auto max-w-[560px] px-6 py-10 sm:px-8"
        onSubmit={(event) => void submitCustom(event)}
      >
        <h1 className="text-24 font-medium text-[var(--text-primary)]">
          {t('bots.roster.customTitle')}
        </h1>
        <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
          {t('bots.roster.customSubtitle')}
        </p>

        {/*
          先写清“这是谁、怎么相处”，再挑名字。角色与性格是伙伴的产品本体,
          自由文本是唯一路径。
        */}
        <div className="mt-7 flex flex-col gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.descriptionLabel')}
            <input
              autoFocus
              value={customDescription}
              onChange={(event) => setCustomDescription(event.target.value)}
              placeholder={t('bots.roster.generate.inputPlaceholder')}
              className="h-10 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 text-14 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.background.title')}
            <textarea
              value={customIdentity}
              onChange={(event) => setCustomIdentity(event.target.value)}
              placeholder={t('bots.background.placeholder')}
              rows={5}
              className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2.5 text-13 leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.persona.title')}
            <textarea
              aria-label={t('bots.persona.title')}
              value={customPersonality}
              onChange={(event) => setCustomPersonality(event.target.value)}
              placeholder={t('bots.persona.freeformPlaceholder')}
              rows={3}
              className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2.5 text-13 leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
            />
            <span className="text-11 leading-4 text-[var(--text-tertiary)]">
              {t('bots.persona.freeformHint')}
            </span>
          </label>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <BotAvatar
            bot={{ name: customName, avatar: customAvatar.emoji, avatarColor: customAvatar.hue }}
            size="lg"
          />
          <label className="min-w-0 flex-1 text-12 text-[var(--text-secondary)]">
            <span className="mb-1.5 block">{t('bots.roster.customNameLabel')}</span>
            <input
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder={t('bots.roster.customNamePlaceholder')}
              className="h-10 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-14 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
              required
            />
          </label>
        </div>

        <p className="mt-4 text-11 leading-4 text-[var(--text-tertiary)]">
          {t('bots.roster.customHint')}
        </p>
        {error ? (
          <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-7 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={creating || customName.trim().length === 0}
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
