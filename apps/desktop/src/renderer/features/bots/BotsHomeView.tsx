import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  FolderOpen,
  MessageCircle,
  PlugZap,
  UserRound,
} from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BotPronounProvider, useBotTranslation } from './botPronounContext';

import { Spinner } from '@/components/ui/spinner';
import * as sessionService from '@/lib/sessionService';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { useRegisterContentHeader } from '../feature-context';
import {
  canonicalBotSessionId,
  setCanonicalBotSession,
  updateBotProfile,
  useBotProfiles,
  getEffectiveBotModelChain,
  type BotCapabilities,
  type BotProfile,
} from './botStore';
import { BotRosterView } from './BotRosterView';
import { BotAvatar } from './BotAvatar';
import { BotBasicProfileFields } from './BotBasicProfileFields';
import {
  createBotCanonicalSessionWithRetry,
  shouldDeferCanonicalBotSessionNavigation,
  withBotCanonicalSessionReadTimeout,
} from './botNavigation';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotSettingsBlock } from './BotSettingsBlock';
import { BotModelChainEditor } from './BotModelChainEditor';
import type { BotSettingsPayload } from './botSettingsAutosave';
import { useBotSettingsAutosave } from './useBotSettingsAutosave';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * 「今天加入 / 3 天前加入」。
 *
 * 口语相对时长，不是「加入 N 天」——这一行是给「TA 跟了我多久」一个人类回答，不是
 * 一个计数。档位与 `bots.growth.time.*` 同一口径（刚刚 / N 天前 / …），只是这里
 * 最细到天：一个伙伴是几分钟前加入的没有意义。拿不到 createdAt 就不显示，不编。
 */
export function botJoinedRelativeKey(
  createdAt: number,
  now: number,
): { key: string; n: number } | null {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  const days = Math.floor((now - createdAt) / DAY_MS);
  if (days <= 0) return { key: 'bots.joined.today', n: 0 };
  if (days === 1) return { key: 'bots.joined.yesterday', n: 1 };
  if (days < 30) return { key: 'bots.joined.days', n: days };
  const months = Math.floor(days / 30);
  if (months < 12) return { key: 'bots.joined.months', n: months };
  return { key: 'bots.joined.years', n: Math.floor(days / 365) };
}

/** Exported for unit tests covering the unified settings page and autosave behavior. */
export function BotSettings({
  bot,
  onBack,
  onOpenSession,
}: {
  bot: BotProfile;
  onBack: () => void;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
}) {
  const { t } = useBotTranslation();
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [identitySource, setIdentitySource] = useState(bot.identitySource ?? '');
  const [userContextSource, setUserContextSource] = useState(bot.userContextSource ?? '');
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot.skills);
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  const [folderError, setFolderError] = useState<string | null>(null);
  const { availableVendors, loaded: availableAgentsLoaded } = useAvailableAgents();
  const hiddenVendors = useMemo<MakerVendor[]>(() => {
    if (!availableAgentsLoaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item));
  }, [availableAgentsLoaded, availableVendors]);
  const canonicalProjection = bot.sessions.find((item) => item.kind === 'chat');
  // 只在切到另一个 Bot 时重灌表单。自动保存下 `bot` 每次落库(以及失败回滚)都会
  // 换一个新对象,若仍按对象身份重灌,用户在提交在途期间敲的字会被服务端快照盖掉,
  // 失败回滚时更会把刚改的内容整批还原 —— 那是比「忘记点保存」更严重的丢字。
  // 页面挂载期间本地 state 才是编辑权威;`bot.channels` / `bot.sessions` 等非表单
  // 字段仍直接读 prop,保持实时。
  const botIdentityRef = useRef(bot.id);
  useEffect(() => {
    if (botIdentityRef.current === bot.id) return;
    botIdentityRef.current = bot.id;
    setName(bot.name);
    setDescription(bot.description);
    setIdentitySource(bot.identitySource ?? '');
    setUserContextSource(bot.userContextSource ?? '');
    setAvatar(bot.avatar);
    setAvatarColor(bot.avatarColor);
    setSelectedSkills(bot.skills);
    setCapabilities(bot.capabilities);
  }, [bot]);

  const commitProfile = useCallback(
    async (payload: BotSettingsPayload) => {
      await updateBotProfile(bot.id, payload);
    },
    [bot.id],
  );

  const autosave = useBotSettingsAutosave({
    draft: {
      name,
      description,
      identitySource,
      userContextSource,
      avatar,
      avatarColor,
      capabilities,
      skills: selectedSkills,
    },
    fallbackName: bot.name,
    // 归档 bot 的设置页是只读的(不渲染任何表单字段),自动保存不得为它引入写入。
    enabled: bot.status !== 'archived',
    commit: commitProfile,
  });

  const updateCapability = <K extends keyof BotCapabilities>(key: K, value: BotCapabilities[K]) => {
    setCapabilities((current) => ({
      ...current,
      [key]: value,
      ...(key === 'fastMode' && current.modelOverride
        ? { modelOverride: { ...current.modelOverride, fastMode: value === true } }
        : {}),
    }));
    autosave.onEdit('instant');
  };
  const handleBack = () => {
    void autosave.flush().then(() => {
      if (autosave.isDirty()) return; // 保存失败:留在页面,状态条给出重试入口
      onBack();
    });
  };

  const joined = botJoinedRelativeKey(bot.createdAt, Date.now());

  // 页面里的普通 Back 行已并入顶栏面包屑。保留键盘可达的同语义出口，是为了
  // 不依赖指针也能离开；保存失败时它仍然只冲刷，不强行丢状态。
  const backToChatControl = (
    <button
      type="button"
      onClick={handleBack}
      aria-label={t('bots.backToChat')}
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:inline-flex focus:items-center focus:gap-2 focus:rounded-lg focus:bg-[var(--surface)] focus:px-2 focus:py-1.5 focus:text-12 focus:text-[var(--text-secondary)] focus:hover:bg-[var(--surface-hover)] focus:hover:text-[var(--text-primary)]"
    >
      {t('bots.backToChat')}
    </button>
  );

  if (bot.status === 'archived') {
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)] px-8 py-8" role="main">
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          {backToChatControl}
          <header className="flex items-center gap-3">
            <BotAvatar bot={bot} size="lg" />
            <div>
              <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                {t('bots.lifecycle.stoppedTitle')}
              </p>
              <h1 className="mt-1 text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
              {bot.description ? (
                <p className="mt-1 text-12 text-[var(--text-secondary)]">{bot.description}</p>
              ) : null}
            </div>
          </header>
          <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />
        </div>
      </main>
    );
  }
  return (
    <main
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--surface)]"
      role="main"
    >
      {backToChatControl}
      <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden px-4 sm:px-6 lg:flex-row lg:px-8">
        <aside className="mx-auto w-full min-w-0 shrink-0 overflow-hidden border-b border-[var(--border-default)] pb-5 lg:mx-0 lg:h-full lg:w-80 lg:max-w-80 lg:border-b-0 lg:pb-0 lg:pr-6">
          <div className="flex w-full min-w-0 max-w-full flex-col gap-6 overflow-hidden pt-4">
            <header className="flex min-w-0 flex-row items-start gap-5 lg:flex-col lg:items-start lg:text-left">
              <BotAvatar bot={{ ...bot, avatar, avatarColor }} size="lg" />

              <div className="flex w-full min-w-0 max-w-full flex-1 flex-col items-start gap-2 overflow-hidden">
                <div className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden">
                  <h1 className="min-w-0 flex-1 truncate text-20 font-medium leading-tight text-[var(--text-primary)]">
                    {name}
                  </h1>
                  {description.trim() ? (
                    <span
                      className="max-w-[45%] shrink truncate rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]"
                      title={description.trim()}
                    >
                      {description.trim()}
                    </span>
                  ) : null}
                </div>
                {joined ? (
                  <span className="text-11 text-[var(--text-tertiary)]">
                    {t(joined.key, { n: joined.n })}
                  </span>
                ) : null}
                {description.trim() ? (
                  <p className="line-clamp-3 w-full max-w-full break-words text-12 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                    {description.trim()}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="flex w-full flex-col gap-2">
              <button
                type="button"
                disabled={!canonicalProjection}
                onClick={() => canonicalProjection && onOpenSession(canonicalProjection.id)}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-4 text-13 font-medium text-[var(--accent-pure-cta-fg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MessageCircle size={15} />
                {t('bots.actions.message')}
              </button>
            </div>

            <div className="flex min-h-4 flex-wrap items-center gap-2">
              {autosave.status === 'saving' ? (
                <span
                  role="status"
                  className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]"
                >
                  <Spinner size={12} />
                  {t('bots.autosave.saving')}
                </span>
              ) : null}
              {autosave.status === 'saved' ? (
                <span
                  role="status"
                  className="inline-flex animate-fade-in items-center gap-1 text-11 text-[var(--text-tertiary)]"
                >
                  <Check size={12} />
                  {t('bots.autosave.saved')}
                </span>
              ) : null}
              {autosave.status === 'error' ? (
                <p
                  className="flex flex-wrap items-center gap-2 text-11 text-[var(--text-danger)]"
                  role="alert"
                >
                  {t('bots.profileApply.saveFailed')}
                  <button
                    type="button"
                    onClick={() => void autosave.retry()}
                    className="rounded-lg px-1.5 py-0.5 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    {t('bots.autosave.retry')}
                  </button>
                </p>
              ) : null}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-8 pt-4 lg:border-l lg:border-[var(--border-default)] lg:pl-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10">
            <BotSettingsBlock
              icon={UserRound}
              title={t('bots.profile.title')}
              hint={t('bots.profile.description')}
            >
              <BotBasicProfileFields
                value={{ name, description, avatar, avatarColor }}
                onChange={(next, kind) => {
                  setName(next.name);
                  setDescription(next.description);
                  setAvatar(next.avatar);
                  setAvatarColor(next.avatarColor);
                  autosave.onEdit(kind);
                }}
              />
            </BotSettingsBlock>
            <BotSettingsBlock
              icon={FolderOpen}
              title={t('bots.homeFolder.title')}
              hint={t('bots.homeFolder.description')}
              action={
                <button
                  type="button"
                  disabled={!bot.homeDir}
                  onClick={() => {
                    if (!bot.homeDir) return;
                    setFolderError(null);
                    void window.electronAPI.openPath(bot.homeDir).then((result) => {
                      if (!result.success)
                        setFolderError(result.error ?? t('bots.homeFolder.openFailed'));
                    });
                  }}
                  className="h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('bots.homeFolder.open')}
                </button>
              }
            >
              <p className="break-words text-11 leading-5 text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                {t('bots.homeFolder.contents')}
              </p>
              {!capabilities.memory ? (
                <button
                  type="button"
                  onClick={() => updateCapability('memory', true)}
                  className="mt-3 h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.memoryRecovery.action')}
                </button>
              ) : null}
              {folderError ? (
                <p className="mt-2 text-11 text-[var(--text-danger)]" role="alert">
                  {folderError}
                </p>
              ) : null}
            </BotSettingsBlock>
            <BotSettingsBlock
              icon={PlugZap}
              title={t('bots.settingsTabs.model')}
              hint={t('bots.modelChain.description')}
              action={
                <button
                  type="button"
                  onClick={() => {
                    const modelChain = getEffectiveBotModelChain();
                    const primary = modelChain[0];
                    if (!primary) return;
                    setCapabilities((current) => ({
                      ...current,
                      ...primary,
                      modelOverride: null,
                      modelChain,
                      modelChainOverride: null,
                    }));
                    autosave.onEdit('instant');
                  }}
                  className="h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.model.restoreDefault')}
                </button>
              }
            >
              <div
                data-testid="bot-model-controls"
                className="flex w-full min-w-0 flex-col gap-5"
              >
                <BotModelChainEditor
                  value={capabilities.modelChain}
                  hiddenVendors={hiddenVendors}
                  onChange={(modelChain) => {
                    const primary = modelChain[0];
                    if (!primary) return;
                    setCapabilities((current) => ({
                      ...current,
                      ...primary,
                      modelChain,
                      modelChainOverride: modelChain,
                      modelOverride: {
                        model: primary.model,
                        providerId: primary.providerId,
                        effort: primary.effort,
                        fastMode: primary.fastMode,
                      },
                    }));
                    autosave.onEdit('instant');
                  }}
                />
              </div>
            </BotSettingsBlock>
            <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />
          </div>
        </section>
      </div>
    </main>
  );
}

export function BotsHomeView() {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const bots = useBotProfiles();
  const creatingBotRef = useRef<{ botId: string; token: symbol } | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<unknown>(null);
  const selectedBot = useMemo(() => bots.find((bot) => bot.id === botId) ?? null, [botId, bots]);
  // `?add=1` 是阵容还在弹模态那阵子的入口。阵容页面化之后它只剩兼容职责:
  // 老书签、老深链一律送到 /bots/roster,不再在这里开一层浮层。
  const addRequested = searchParams.get('add') === '1';
  const settingsOpen = searchParams.get('settings') === '1';

  const createCanonicalSession = useCallback(
    async (
      bot: BotProfile,
      expectedCanonicalSessionId: string | null = canonicalBotSessionId(bot) ?? null,
      recoverMissingOnly = false,
    ): Promise<import('@/lib/ccAgent.types').Session> => {
      try {
        setCreateSessionError(null);
        const result = await createBotCanonicalSessionWithRetry(() =>
          window.electronAPI.localDb.bots.createCanonicalSession({
            botId: bot.id,
            expectedCanonicalSessionId,
            expectedProfileVersion: bot.currentVersion ?? 1,
            recoverMissingOnly,
          }),
        );
        const updated = result.session;
        setCanonicalBotSession(bot.id, {
          id: updated.id,
          title: updated.title,
          updatedAt: Date.now(),
        });
        return updated;
      } catch (error) {
        setCreateSessionError(error);
        throw error;
      }
    },
    [],
  );

  const retryCanonicalSessionCreation = useCallback(
    async (bot: BotProfile): Promise<void> => {
      creatingBotRef.current = null;
      setCreateSessionError(null);
      setIsCreatingSession(true);
      try {
        const session = await createCanonicalSession(bot);
        navigate(`/bots/${bot.id}/session/${session.id}`, { replace: true });
      } catch {
        // createCanonicalSession stores the actual IPC error for the error state.
      } finally {
        creatingBotRef.current = null;
        setIsCreatingSession(false);
      }
    },
    [createCanonicalSession, navigate],
  );

  useEffect(() => {
    if (!addRequested) return;
    navigate('/bots/roster', { replace: true });
  }, [addRequested, navigate]);

  useEffect(() => {
    if (addRequested) return;
    // 已经有伙伴，但 URL 指着一个不存在的（刚被删掉 / 手改过的链接）：回伙伴总览，
    // 由下面那条重定向落到第一个伙伴。以前这里会停在一页空态，现在会停在 spinner
    // ——两个都不是答案，直接把人送回有东西的地方。
    if (botId && bots.length > 0 && !selectedBot) {
      navigate('/bots', { replace: true });
      return;
    }
    if (!botId && bots[0]) {
      const target = bots.find((bot) => bot.status !== 'archived') ?? bots[0];
      const query = searchParams.toString();
      const nextQuery =
        target.status !== 'active'
          ? new URLSearchParams({ ...Object.fromEntries(searchParams), settings: '1' }).toString()
          : query;
      navigate(`/bots/${target.id}${nextQuery ? `?${nextQuery}` : ''}`, { replace: true });
    }
  }, [addRequested, botId, bots, navigate, searchParams, selectedBot]);

  // 顶栏注入区:伙伴页保留「头像 + 名字」入口;设置页升级成
  // 「头像 + 名字 > 设置」面包屑,让当前页归属一眼可见。
  const headerContent = useMemo(
    () =>
      selectedBot ? (
        settingsOpen ? (
          <div className="flex min-w-0 items-center gap-1 text-13" aria-label={t('bots.settings')}>
            <button
              type="button"
              onClick={() => navigate(`/bots/${selectedBot.id}`)}
              title={t('bots.backToChat')}
              className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <BotAvatar bot={selectedBot} size="xs" />
              <span className="min-w-0 truncate">{selectedBot.name}</span>
            </button>
            <ChevronRight
              size={14}
              aria-hidden="true"
              className="shrink-0 text-[var(--text-tertiary)]"
            />
            <span className="shrink-0 px-1 font-medium text-[var(--text-primary)]">
              {t('bots.settings')}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => navigate(`/bots/${selectedBot.id}?settings=1`)}
            title={t('bots.settings')}
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <BotAvatar bot={selectedBot} size="xs" />
            <span className="min-w-0 truncate">{selectedBot.name}</span>
          </button>
        )
      ) : (
        <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
          <Bot size={15} />
          {t('bots.title')}
        </div>
      ),
    [navigate, selectedBot, settingsOpen, t],
  );
  useRegisterContentHeader(headerContent);

  useEffect(() => {
    if (!selectedBot || shouldDeferCanonicalBotSessionNavigation({ settingsOpen, addRequested }))
      return;
    if (selectedBot.status !== 'active') {
      navigate(`/bots/${selectedBot.id}?settings=1`, { replace: true });
      return;
    }

    const canonicalSessionId = canonicalBotSessionId(selectedBot);
    let cancelled = false;
    if (canonicalSessionId) {
      setIsCreatingSession(false);
      void window.electronAPI.localDb.bots
        .renewIfDue({ botId: selectedBot.id })
        .catch(() => ({ renewed: false, canonicalSessionId }))
        .then((renewal) => {
          const activeSessionId = renewal.canonicalSessionId ?? canonicalSessionId;
          if (activeSessionId !== canonicalSessionId) {
            setCanonicalBotSession(selectedBot.id, {
              id: activeSessionId,
              title: selectedBot.name,
              updatedAt: Date.now(),
            });
          }
          return withBotCanonicalSessionReadTimeout(() => sessionService.get(activeSessionId));
        })
        .then(async (session) => {
          if (cancelled) return;
          if (session.status !== 'active') {
            setIsCreatingSession(true);
            const next = await createCanonicalSession(selectedBot);
            if (!cancelled) {
              setIsCreatingSession(false);
              if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
            }
            return;
          }
          if (session.source !== 'bot') {
            // A renderer-held canonicalSessionId is not authority to reclassify an
            // arbitrary existing Session. Preserve the existing task and create a
            // fresh Bot-owned Session instead.
            setIsCreatingSession(true);
            const next = await createCanonicalSession(selectedBot);
            if (!cancelled) {
              setIsCreatingSession(false);
              if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
            }
            return;
          }
          setCanonicalBotSession(selectedBot.id, {
            id: session.id,
            title: session.title || selectedBot.name,
            updatedAt: Date.parse(session.updatedAt) || Date.now(),
          });
          if (!cancelled && sessionId !== session.id) {
            navigate(`/bots/${selectedBot.id}/session/${session.id}`, { replace: true });
          }
        })
        .catch(async () => {
          if (cancelled) return;
          setIsCreatingSession(true);
          // The profile pointer is still the CAS authority even when its Session
          // row disappeared. Passing null can never repair that state because
          // main correctly sees a non-null canonical pointer. Preserve the
          // observed id so a concurrent Renew still loses the CAS safely.
          const next = await createCanonicalSession(selectedBot, canonicalSessionId, true).catch(
            () => null,
          );
          if (!cancelled) {
            setIsCreatingSession(false);
            if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (sessionId || creatingBotRef.current?.botId === selectedBot.id) return;

    const attemptToken = Symbol('bot-canonical-create');
    creatingBotRef.current = { botId: selectedBot.id, token: attemptToken };
    setIsCreatingSession(true);
    void createCanonicalSession(selectedBot)
      .then((session) => {
        if (cancelled) return;
        navigate(`/bots/${selectedBot.id}/session/${session.id}`, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (creatingBotRef.current?.token === attemptToken) {
          creatingBotRef.current = null;
        }
        if (!cancelled) setIsCreatingSession(false);
      });

    return () => {
      cancelled = true;
      if (creatingBotRef.current?.token === attemptToken) {
        creatingBotRef.current = null;
      }
    };
  }, [addRequested, createCanonicalSession, selectedBot, sessionId, settingsOpen, navigate]);

  if (!selectedBot) {
    // 一个伙伴都没有 → 主区直接就是阵容页,没有中间那一层。
    //
    // 这里曾经是另一套「还没有伙伴」推销页:Bot 图标 + 四张功能卖点卡（长期身份 /
    // 自动接收任务事件 / 自动化与协同 / 按需挂载消息通道）+ 一个「添加伙伴」按钮,
    // 点了才弹出阵容模态。它用产品内部术语介绍一个本来靠「挑一个合拍的」就能懂的
    // 东西,还把定稿最重要的第一印象藏在两层之后。整页删除,不做兼容。
    if (bots.length === 0) return <BotRosterView />;
    // 有伙伴但 URL 还没落到具体一个(上面的重定向正在路上):安静地等,不要闪一页
    // 阵容再跳走。
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]" role="main">
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      </main>
    );
  }

  if (settingsOpen) {
    return (
      // 设置页整棵子树共用同一个第三人称:文案里的 {{pronoun}} 按这个伙伴的性别
      // 取「她 / 他」,自建伙伴取它的名字(裁决:不用「TA」)。
      <BotPronounProvider bot={selectedBot}>
        <BotSettings
          // 切到另一个 Bot 必须重挂:自动保存的基线、防抖计时与「未落即冲刷」都绑在
          // 实例上,复用实例会让上一个 Bot 的待保存改动记在新 Bot 头上。
          key={selectedBot.id}
          bot={selectedBot}
          onOpenSession={(targetSessionId, searchJump) => {
            const projection = selectedBot.sessions.find((item) => item.id === targetSessionId);
            const route =
              projection?.kind === 'history'
                ? `/bots/${selectedBot.id}/history/${targetSessionId}`
                : `/bots/${selectedBot.id}/session/${targetSessionId}`;
            navigate(route, { state: searchJump ? { searchJump } : undefined });
          }}
          onBack={() => {
            if (selectedBot.status === 'archived') {
              navigate('/bots', { replace: true });
              return;
            }
            setSearchParams(
              (current) => {
                current.delete('settings');
                return current;
              },
              { replace: true },
            );
          }}
        />
      </BotPronounProvider>
    );
  }

  return (
    <main className="flex h-full items-center justify-center bg-[var(--surface)]" role="main">
      {createSessionError && !isCreatingSession ? (
        <div className="flex max-w-lg flex-col items-center gap-3 px-6 text-center">
          <p className="text-13 text-[var(--text-secondary)]">
            {t('ccAgent.draft.createSessionFailed')}
          </p>
          {/* 文案写着「请重试」,却没有任何能按的东西 —— 只能切走再切回来才会重建
              (2026-08-21 实测撞上一次瞬时失败)。这里补上真正的重试入口。 */}
          {selectedBot ? (
            <button
              type="button"
              onClick={() => void retryCanonicalSessionCreation(selectedBot)}
              className="h-8 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              {t('commonUi.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        // Opening a Bot is a hand-off to its canonical chat, not a page of its
        // own: show a quiet spinner instead of full-screen "loading" text.
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      )}
    </main>
  );
}
