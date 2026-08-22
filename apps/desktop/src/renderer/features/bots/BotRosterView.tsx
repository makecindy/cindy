import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { DEFAULT_CONTROL_BOT_EVENT_RULE } from '../../../shared/botSessionEvents';
import type { BotMemorySeedEntry } from '../../../shared/botMemorySeed';
import type { BotPersonaDraft } from '../../../shared/botPersonaDraft';
import {
  addBotProfileAndWait,
  useBotProfiles,
  type BotCapabilities,
  type BotProfile,
} from './botStore';
import {
  BotAvatar,
  botAvatarAssignment,
  BotAvatarPicker,
  BOT_PRESET_AVATAR_SRC,
  presetAvatarValue,
  parsePresetAvatarId,
  BOT_PRESET_AVATAR_IDS,
  type BotAvatarAssignment,
  type BotAvatarHue,
} from './BotAvatar';
import { botPronoun } from '../../../shared/botGender';
import { rememberPendingBotWelcome, type PendingBotWelcome } from './botWelcome';
import {
  botManualWelcome,
  botPersonaCreateInput,
  botPersonaGenerateErrorKey,
  botPersonaSeedEntries,
  botPersonaWelcome,
  resolveDraftAvatar,
} from './botPersonaGenerate';
import {
  BOT_TEMPLATES,
  CUSTOM_BOT_TEMPLATE_ID,
  botTemplateSeedEntries,
  type BotTemplateDefinition,
} from './botTemplates';

/**
 * 认识你的伙伴 —— 阵容页。
 *
 * 它是**主区的一页**，不是浮在对话上的模态：第一次打开伙伴看到的应该是一屋子可以
 * 挑的人，而不是先看一页功能卖点、再点一次才弹出一层遮住左栏的浮层。左栏在整个过程
 * 中都还在，用户随时能看见自己已经有谁。
 *
 * 挑一张卡就是创建本身：没有名字栏、没有描述栏、没有身份 textarea。模板已经知道的
 * 事（口气、头像、能力、事件订阅、打招呼）跟着角色一起来；普通用户不需要提前决定的
 * 事（harness、任务控制、消息通道）留作模板默认值，之后在 TA 自己的设置里改。只有
 * 空白卡会问东西，而且只问两件谁也替不了你决定的：叫什么、长什么样。
 */
interface BotRosterViewProps {
  /** 创建成功后的落点。默认直接进 TA 的对话。 */
  onCreated?: (bot: BotProfile) => void;
  /** 宿主页面转交的一句话回执（导入成功 / 导入失败），显示在页头下方。 */
  notice?: string | null;
}

/**
 * 「初始记忆」落地。写不进去不回滚伙伴 —— 人已经加入了,为了几条开场笔记把 TA
 * 撤掉才是更坏的结果;设置页「TA 记得的」此时显示的是**真实的空**,不是假内容。
 */
async function seedBotMemories(botId: string, entries: readonly BotMemorySeedEntry[]) {
  if (entries.length === 0) return;
  const seed = window.electronAPI?.maker?.botMemory?.seed;
  if (!seed) return;
  try {
    await seed(botId, entries);
  } catch (cause) {
    console.warn('[bots] seeding initial memories failed', botId, cause);
  }
}

export function BotRosterView({ onCreated, notice }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const [view, setView] = useState<'roster' | 'custom'>('roster');
  /**
   * 自定义路径的三步。
   *
   * `ask` 是**默认落点**:进「自己捏一个」先问一句「TA 是谁」,一句话就能换回一份
   * 完整草稿。`manual` 是原来那张「名字 + 头像」的表,由「跳过,自己写」进入 ——
   * 它一步没少,只是不再是唯一的路;生成不可用时永远还有它兜着。
   */
  const [customStep, setCustomStep] = useState<'ask' | 'preview' | 'manual'>('ask');
  const [roleInput, setRoleInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BotPersonaDraft | null>(null);
  /**
   * 预览卡上那张脸。单独存,不塞回草稿:草稿的 `avatarPreset` 只装得下「随包立绘
   * 的 id」,而选择器同样允许挑 emoji + 底色 —— 硬塞回去会让用户选的 emoji 在
   * 下一次渲染时被"认不出来"并悄悄换成哈希头像。
   */
  const [draftAvatar, setDraftAvatar] = useState<BotAvatarAssignment | null>(null);
  /**
   * 模型生成时用的那个名字。用户在预览卡上改了名之后,模型现造的那句开场白里念的
   * 就是个不存在的名字了 —— 靠这个原值判定,改过就回落到带当前名字的模板句。
   */
  const [pristineDraftName, setPristineDraftName] = useState('');
  const [customName, setCustomName] = useState('');
  const [customAvatar, setCustomAvatar] = useState<BotAvatarAssignment>(() =>
    botAvatarAssignment(`${Date.now()}:${Math.random()}`),
  );
  /** Which card is mid-flight — also the "one create at a time" latch. */
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view !== 'custom') return;
    setError(null);
    setCustomStep('ask');
    setGenerateError(null);
    setDraft(null);
    setDraftAvatar(null);
    setPristineDraftName('');
  }, [view]);

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

  /**
   * 实心主按钮落在**第一张还能点的卡**上，而不是固定第一张。
   *
   * 「只有一张实心」是为了给这一页一个落点；固定 index 0 的话，等用户把第一位
   * 伙伴请进来之后，整页就再也没有实心按钮了 —— 恰恰是回头再来看阵容的时候，
   * 眼睛没有了落点。已加入的卡本来就是不可点的次要态，让位给下一张才对。
   */
  const primaryTemplateId = BOT_TEMPLATES.find((template) => !isJoined(template))?.id ?? null;

  const handleCreated = (bot: BotProfile) => {
    if (onCreated) {
      onCreated(bot);
      return;
    }
    navigate(`/bots/${bot.id}`);
  };

  const create = async (
    id: string,
    input: {
      name: string;
      description: string;
      identitySource: string;
      avatar: string;
      avatarColor: BotAvatarHue | string;
      template: BotTemplateDefinition | null;
      /** 模板之外的能力基线(AI 生成的伙伴用普通助理那一套)。 */
      capabilities?: Partial<BotCapabilities>;
      /** 加入即写进 TA 记忆空间的开场笔记。按 slug 幂等,失败不回滚伙伴。 */
      seedEntries?: readonly BotMemorySeedEntry[];
      /**
       * 模板之外的开场白。阵容页脚注「加入后 TA 会先跟你打个招呼」是对**所有**
       * 创建路径的承诺,所以手捏与生成两条路各自带一句,不能只有模板卡兑现。
       */
      welcome?: PendingBotWelcome;
    },
  ) => {
    if (creatingId) return;
    setCreatingId(id);
    setError(null);
    try {
      const capabilities = input.template?.capabilities ?? input.capabilities;
      const bot = await addBotProfileAndWait({
        name: input.name,
        channel: 'local',
        description: input.description,
        identitySource: input.identitySource,
        // 角色性别跟着模板走 —— 界面文案据此用「她 / 他」。自定义伙伴没有这个
        // 字段(留空 = neutral),文案改用伙伴自己的名字,见 shared/botGender.ts。
        ...(input.template?.gender ? { gender: input.template.gender } : {}),
        // Hermes keeps USER context separate from SOUL. Templates do not
        // invent facts about the owner; users can add them in Bot Settings.
        userContextSource: '',
        avatar: input.avatar,
        avatarColor: input.avatarColor,
        skills: [],
        ...(capabilities ? { capabilities } : {}),
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
      const welcome = input.template ? input.template.welcomeKey : input.welcome;
      if (welcome) rememberPendingBotWelcome(bot.id, welcome);
      // 在跳进对话之前写完:用户从对话点进设置时,「TA 记得的」就已经有东西了。
      await seedBotMemories(bot.id, input.seedEntries ?? []);
      handleCreated(bot);
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
      welcome: botManualWelcome(name),
    });
  };

  /**
   * 「帮我生成」。
   *
   * 每一条失败路径都要说人话:通道不在(旧 preload / 远程镜像)、账号没连上、
   * 模型答非所问 —— 分类各不相同,但共同点是**用户看得见发生了什么**,而且
   * 「跳过,自己写」始终摆在旁边。静默失败(点了没反应)是这条链路最不能接受的结局。
   */
  const runGenerate = async (event: FormEvent) => {
    event.preventDefault();
    const role = roleInput.trim();
    if (!role || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const generate = window.electronAPI?.maker?.generateBotPersona;
      if (!generate) {
        setGenerateError(t('bots.roster.generate.errors.unavailable'));
        return;
      }
      const result = await generate(role);
      if (!result.ok) {
        setGenerateError(t(botPersonaGenerateErrorKey(result.code)));
        return;
      }
      setDraft(result.draft);
      setPristineDraftName(result.draft.name);
      const suggested = resolveDraftAvatar(result.draft);
      setDraftAvatar({ emoji: suggested.avatar, hue: suggested.hue });
      setCustomStep('preview');
    } catch (cause) {
      setGenerateError(
        cause instanceof Error ? cause.message : t('bots.roster.generate.errors.failed'),
      );
    } finally {
      setGenerating(false);
    }
  };

  const createFromDraft = () => {
    if (!draft) return;
    const input = botPersonaCreateInput(draft);
    if (!input.name) return;
    void create('generated', {
      name: input.name,
      description: input.description,
      identitySource: input.identitySource,
      // 用户在预览卡上换过脸就用他挑的那张;没换过时 draftAvatar 就是建议值本身。
      avatar: draftAvatar?.emoji ?? input.avatar,
      avatarColor: draftAvatar?.hue ?? input.avatarColor,
      template: null,
      capabilities: input.capabilities,
      seedEntries: botPersonaSeedEntries(draft),
      welcome: botPersonaWelcome(draft, pristineDraftName),
    });
  };

  if (view === 'custom' && customStep === 'ask') {
    /*
      第一步只问一句话。

      「自己捏一个」原本上来就是一张空表:名字、头像,剩下的自己去设置里补。可
      大多数人心里有的不是名字,是**用途**——「设计师」「能帮我盯娃学习的助理」。
      所以这一屏把那句用途接下来,换回一份可以改的完整草稿;真想自己写的人,
      「跳过,自己写」还在原地,一步没多。
    */
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)]" role="main">
        <form className="mx-auto max-w-[560px] px-6 py-10 sm:px-8" onSubmit={runGenerate}>
          <h1 className="text-24 font-medium text-[var(--text-primary)]">
            {t('bots.roster.generate.title')}
          </h1>
          <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
            {t('bots.roster.generate.subtitle')}
          </p>

          <label className="mt-7 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.roster.generate.inputLabel')}
            <textarea
              autoFocus
              value={roleInput}
              onChange={(event) => setRoleInput(event.target.value)}
              placeholder={t('bots.roster.generate.inputPlaceholder')}
              rows={3}
              className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2.5 text-14 leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
            />
          </label>

          {generateError ? (
            <p className="mt-3 text-12 leading-5 text-[var(--text-danger)]" role="alert">
              {generateError}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={generating || roleInput.trim().length === 0}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
            >
              {generating ? <Spinner size={14} /> : <Sparkles size={14} aria-hidden />}
              {generating ? t('bots.roster.generate.generating') : t('bots.roster.generate.action')}
            </button>
            {/* 「自己写」永远可用 —— 它不是失败时才出现的补救,而是一条平级的路。 */}
            <button
              type="button"
              onClick={() => setCustomStep('manual')}
              className="rounded-lg text-12 text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
            >
              {t('bots.roster.generate.skip')}
            </button>
            <button
              type="button"
              onClick={() => setView('roster')}
              className="h-9 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              {t('bots.roster.backToRoster')}
            </button>
          </div>
        </form>
      </main>
    );
  }

  if (view === 'custom' && customStep === 'preview' && draft) {
    /*
      预览卡 = 草稿本身,不是一张"确认页"。

      名字、头像、简介、背景全文、每一条初始记忆都在这里就能改 / 删,改完才落库。
      把生成结果直接创建出来再让用户去设置里翻着改,等于把返工推给用户。
    */
    const preview = draftAvatar ?? {
      emoji: resolveDraftAvatar(draft).avatar,
      hue: resolveDraftAvatar(draft).hue,
    };
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)]" role="main">
        <div className="mx-auto max-w-[560px] px-6 py-10 sm:px-8">
          <h1 className="text-24 font-medium text-[var(--text-primary)]">
            {t('bots.roster.generate.previewTitle')}
          </h1>
          <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
            {/* 预览里草稿已经有名字了,第三人称就用它自己的名字(自建伙伴无性别)。 */}
            {t('bots.roster.generate.previewSubtitle', {
              pronoun: botPronoun('neutral', draft.name),
            })}
          </p>

          <div className="mt-7 flex flex-col gap-4 rounded-xl border border-[var(--border-default)] p-5">
            <div className="flex items-center gap-3">
              <BotAvatarPicker
                name={draft.name}
                avatar={preview.emoji}
                avatarColor={preview.hue}
                onChange={setDraftAvatar}
              />
              <div className="min-w-0 flex-1">
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  aria-label={t('bots.roster.customNameLabel')}
                  className="h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:border-[var(--focus-ring)]"
                />
              </div>
            </div>

            <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
              {t('bots.roster.generate.descriptionLabel')}
              <input
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, description: event.target.value } : current,
                  )
                }
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:border-[var(--focus-ring)]"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
              {t('bots.background.title')}
              <textarea
                value={draft.identity}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, identity: event.target.value } : current,
                  )
                }
                rows={7}
                className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12 leading-5 text-[var(--text-primary)] outline-none focus:border-[var(--focus-ring)]"
              />
            </label>

            <div>
              <p className="text-12 text-[var(--text-secondary)]">
                {t('bots.roster.generate.memoriesLabel', {
                  pronoun: botPronoun('neutral', draft.name),
                })}
              </p>
              {draft.memories.length === 0 ? (
                <p className="mt-1.5 text-11 leading-4 text-[var(--text-tertiary)]">
                  {t('bots.roster.generate.memoriesEmpty')}
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {draft.memories.map((memory, index) => (
                    <li
                      key={`${memory.title}:${index}`}
                      className="flex items-start justify-between gap-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-12 text-[var(--text-primary)]">
                          {memory.title}
                        </span>
                        <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
                          {memory.description}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={t('bots.memoryList.deleteAria', { title: memory.title })}
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  memories: current.memories.filter((_, i) => i !== index),
                                }
                              : current,
                          )
                        }
                        className="shrink-0 rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-danger)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {error ? (
            <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={creatingId !== null || draft.name.trim().length === 0}
              onClick={createFromDraft}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
            >
              {creatingId !== null ? <Spinner size={14} /> : null}
              {t('bots.roster.generate.confirm')}
            </button>
            <button
              type="button"
              onClick={() => setCustomStep('ask')}
              className="h-9 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              {t('bots.roster.generate.regenerate')}
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (view === 'custom') {
    const selectedPreset = parsePresetAvatarId(customAvatar.emoji);
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)]" role="main">
        <form className="mx-auto max-w-[560px] px-6 py-10 sm:px-8" onSubmit={submitCustom}>
          <h1 className="text-24 font-medium text-[var(--text-primary)]">
            {t('bots.roster.customTitle')}
          </h1>
          <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
            {t('bots.roster.customSubtitle')}
          </p>

          <label className="mt-7 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.roster.customNameLabel')}
            <input
              autoFocus
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder={t('bots.roster.customNamePlaceholder')}
              className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
              required
            />
          </label>

          {/*
            「挑张脸」是这一步的一半，所以候选直接摊在页面上：八张随包的角色像各占
            一个 56px 格子，点一下就选中。想要 emoji 或换底色的少数人再点最后那格
            打开完整选择器 —— 常见路径零额外点击，能力一件不少。
          */}
          <div className="mt-5">
            <p className="text-12 text-[var(--text-secondary)]">
              {t('bots.roster.customAvatarLabel')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {BOT_PRESET_AVATAR_IDS.map((id) => {
                const selected = selectedPreset === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() =>
                      setCustomAvatar((current) => ({
                        ...current,
                        emoji: presetAvatarValue(id),
                      }))
                    }
                    aria-pressed={selected}
                    aria-label={t(`bots.avatarPicker.presets.${id}`)}
                    className={cn(
                      'flex h-14 w-14 items-center justify-center rounded-full border-2 transition-colors',
                      selected
                        ? 'border-[var(--text-primary)]'
                        : 'border-transparent hover:border-[var(--border-default)]',
                    )}
                  >
                    <img
                      src={BOT_PRESET_AVATAR_SRC[id]}
                      alt=""
                      aria-hidden
                      draggable={false}
                      className="pointer-events-none h-12 w-12 select-none rounded-full object-cover"
                      style={{ backgroundColor: 'var(--surface-chip)' }}
                    />
                  </button>
                );
              })}
              <BotAvatarPicker
                name={customName}
                avatar={customAvatar.emoji}
                avatarColor={customAvatar.hue}
                onChange={setCustomAvatar}
                size="lg"
              />
            </div>
          </div>

          <p className="mt-4 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.roster.customHint')}
          </p>
          {error ? (
            <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-7 flex items-center gap-2">
            <button
              type="submit"
              disabled={creatingId !== null || customName.trim().length === 0}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
            >
              {creatingId !== null ? <Spinner size={14} /> : null}
              {/* 自建伙伴还没有性别,按裁决用它自己的名字;名字没填时按钮本来就是禁用的。 */}
              {t('bots.roster.join', { pronoun: botPronoun('neutral', customName) })}
            </button>
            <button
              type="button"
              onClick={() => setView('roster')}
              className="h-9 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              {t('bots.roster.backToRoster')}
            </button>
          </div>
        </form>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-[var(--surface)]" role="main">
      <div className="mx-auto max-w-4xl px-6 py-10 sm:px-8">
        <div className="text-center">
          <h1 className="text-24 font-medium text-[var(--text-primary)]">
            {t('bots.roster.title')}
          </h1>
          <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
            {t('bots.roster.subtitle')}
          </p>
        </div>

        {notice ? (
          <p
            className="mx-auto mt-5 w-fit rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-12 leading-5 text-[var(--text-secondary)]"
            role="status"
          >
            {notice}
          </p>
        ) : null}

        <div
          className="mt-8 grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(244px, 1fr))' }}
        >
          {BOT_TEMPLATES.map((template) => {
            const joined = isJoined(template);
            const name = t(template.nameKey);
            // 每张卡自己的第三人称。阵容页同屏站着八个人,不存在「当前伙伴」可以
            // 供进 context,所以这里按卡取值:小满是「她」,老陈是「他」。
            const pronoun = botPronoun(template.gender, name);
            // 只有一张是实心主按钮。六张卡全实心的一页没有落点,眼睛不知道先看哪
            // 一张;定稿把「先看这个」交给第一张还能点的,其余是同级的描边次选。
            const primary = template.id === primaryTemplateId;
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
                      // 角色自带的开场笔记跟着人一起来 —— 卡上写着 TA 是谁,
                      // 加进来之后「TA 记得的」就不该是一片空白。
                      seedEntries: botTemplateSeedEntries(template, t),
                    })
                  }
                  className={cn(
                    'mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-full text-12 font-medium transition-opacity',
                    joined
                      ? 'cursor-default border border-[var(--border-default)] text-[var(--text-tertiary)]'
                      : primary
                        ? 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50'
                        : 'border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50',
                  )}
                >
                  {creatingId === template.id ? <Spinner size={14} /> : null}
                  {joined ? t('bots.roster.joined') : t('bots.roster.join', { pronoun })}
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

        <div className="mt-6 flex flex-col gap-2">
          <p className="text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.roster.footerHint')}
          </p>
          {/* 「已经有伙伴文件？导入一个」——复用既有 ?import=1 流程,不另开一条导入路径。 */}
          <button
            type="button"
            onClick={() => navigate('/bots?import=1')}
            className="w-fit rounded-lg text-11 text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
          >
            {t('bots.roster.importLink')}
          </button>
        </div>
      </div>
    </main>
  );
}
