import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, FolderOpen } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useBotTranslation } from './botPronounContext';

import { Spinner } from '@/components/ui/spinner';
import * as sessionService from '@/lib/sessionService';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { useRegisterContentHeader } from '../feature-context';
import {
  canonicalBotSessionId,
  chooseBotAvatar,
  retryBotInvitation,
  setCanonicalBotSession,
  updateBotProfile,
  useBotProfiles,
  getEffectiveBotModelChain,
  type BotCapabilities,
  type BotProfile,
} from './botStore';
import { BotCreateMenu } from './BotCreateMenu';
import { BotAvatar } from './BotAvatar';
import { BotBasicProfileFields } from './BotBasicProfileFields';
import {
  createBotCanonicalSessionWithRetry,
  shouldDeferCanonicalBotSessionNavigation,
  withBotCanonicalSessionReadTimeout,
} from './botNavigation';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotInvitationWelcome } from './BotInvitationWelcome';
import { BotModelChainEditor } from './BotModelChainEditor';
import type { BotSettingsPayload } from './botSettingsAutosave';
import { useBotSettingsAutosave } from './useBotSettingsAutosave';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * 「今天加入 / 3 天前加入」。
 *
 * 口语相对时长，不是「加入 N 天」——这一行是给「TA 跟了我多久」一个人类回答，不是
 * 一个计数。这里只保留对长期伙伴有意义的天／月／年档位：一个伙伴是几分钟前加入
 * 没有意义。拿不到 createdAt 就不显示，不编。
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
  const [portraitRetryFailed, setPortraitRetryFailed] = useState(false);
  const [identitySource, setIdentitySource] = useState(bot.identitySource ?? '');
  const [userContextSource, setUserContextSource] = useState(bot.userContextSource ?? '');
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot.skills);
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const { availableVendors, loaded: availableAgentsLoaded } = useAvailableAgents();
  const hiddenVendors = useMemo<MakerVendor[]>(() => {
    if (!availableAgentsLoaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item));
  }, [availableAgentsLoaded, availableVendors]);
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

  if (bot.status === 'archived') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex max-w-xl flex-col gap-5">
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
      </div>
    );
  }

  const handleChooseAvatar = async () => {
    setAvatarError(false);
    await autosave.flush();
    if (autosave.isDirty()) return;
    setAvatarBusy(true);
    try {
      const next = await chooseBotAvatar(bot.id);
      if (!next) return;
      setAvatar(next.avatar);
      setAvatarColor(next.avatarColor);
    } catch {
      setAvatarError(true);
    } finally {
      setAvatarBusy(false);
    }
  };

  if (
    bot.invitation &&
    bot.invitation.stage !== 'ready' &&
    !(bot.invitation.stage === 'avatar' && bot.canonicalSessionId)
  )
    return <BotInvitationWelcome bot={bot} />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 sm:px-7">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 pb-10">
        <div className="flex min-h-5 items-center justify-end pt-1">
          {autosave.status === 'saving' ? (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]"
            >
              <Spinner size={12} /> {t('bots.autosave.saving')}
            </span>
          ) : autosave.status === 'saved' ? (
            <span
              role="status"
              className="inline-flex animate-fade-in items-center gap-1 text-11 text-[var(--text-tertiary)]"
            >
              <Check size={12} /> {t('bots.autosave.saved')}
            </span>
          ) : autosave.status === 'error' ? (
            <p className="flex items-center gap-2 text-11 text-[var(--text-danger)]" role="alert">
              {t('bots.profileSaveFailed')}
              <button
                type="button"
                onClick={() => void autosave.retry()}
                className="font-medium text-[var(--text-primary)]"
              >
                {t('bots.autosave.retry')}
              </button>
            </p>
          ) : null}
        </div>

        <BotBasicProfileFields
          value={{ name, description, avatar, avatarColor }}
          avatarBusy={avatarBusy}
          onChooseAvatar={() => void handleChooseAvatar()}
          onChange={(next, kind) => {
            setName(next.name);
            setDescription(next.description);
            setAvatar(next.avatar);
            setAvatarColor(next.avatarColor);
            autosave.onEdit(kind);
          }}
        />
        {bot.invitation?.avatarSkipped ? (
          <p className="text-12 text-[var(--text-tertiary)]">
            {t('bots.invitation.avatarSkipped')}
            <button
              type="button"
              onClick={() => {
                setPortraitRetryFailed(false);
                void retryBotInvitation(bot.id).catch(() => setPortraitRetryFailed(true));
              }}
              disabled={bot.invitation.stage === 'avatar'}
              className="ml-2 text-[var(--text-primary)] underline underline-offset-2 disabled:opacity-50"
            >
              {t('commonUi.retry')}
            </button>
            {portraitRetryFailed ? (
              <span role="alert">{t('bots.invitation.retryFailed')}</span>
            ) : null}
          </p>
        ) : null}
        {avatarError ? (
          <p className="text-center text-11 text-[var(--text-danger)]" role="alert">
            {t('bots.profile.avatarFailed')}
          </p>
        ) : null}

        <details className="text-13 text-[var(--text-secondary)]">
          <summary className="cursor-pointer py-2">{t('bots.profile.personality')}</summary>
          <textarea
            aria-label={t('bots.profile.personality')}
            value={identitySource}
            onChange={(event) => {
              setIdentitySource(event.target.value);
              autosave.onEdit('text');
            }}
            rows={6}
            className="mt-2 w-full resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface)] p-3 text-13 leading-6 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          />
        </details>

        <section
          aria-label={t('bots.settingsTabs.model')}
          className="min-w-0 border-t border-[var(--border-default)] pt-4"
        >
          <div data-testid="bot-model-controls" className="min-w-0">
            <BotModelChainEditor
              label={t('bots.settingsTabs.model')}
              onRestoreDefault={() => {
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
        </section>

        <details className="group rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
          <summary className="cursor-pointer list-none px-4 py-3 text-12 font-medium text-[var(--text-secondary)] marker:content-none">
            {t('bots.homeFolder.title')}
          </summary>
          <div className="border-t border-[var(--border-default)] p-4">
            <div className="flex items-start gap-3">
              <FolderOpen size={16} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
              <div className="min-w-0 flex-1">
                <p className="text-12 leading-5 text-[var(--text-secondary)]">
                  {t('bots.homeFolder.description')}
                </p>
                <p className="mt-1 break-words text-11 leading-5 text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                  {t('bots.homeFolder.contents')}
                </p>
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
                  className="mt-3 h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                >
                  {t('bots.homeFolder.open')}
                </button>
                {!capabilities.memory ? (
                  <button
                    type="button"
                    onClick={() => updateCapability('memory', true)}
                    className="ml-2 mt-3 h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    {t('bots.memoryRecovery.action')}
                  </button>
                ) : null}
                {folderError ? (
                  <p className="mt-2 text-11 text-[var(--text-danger)]" role="alert">
                    {folderError}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-4">
              <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />
            </div>
          </div>
        </details>
      </div>
      <button type="button" onClick={handleBack} className="sr-only">
        {t('bots.backToChat')}
      </button>
    </div>
  );
}

export function BotsHomeView() {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const bots = useBotProfiles();
  const creatingBotRef = useRef<{ botId: string; token: symbol } | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<unknown>(null);
  const selectedBot = useMemo(() => bots.find((bot) => bot.id === botId) ?? null, [botId, bots]);
  // `?add=1` 是阵容还在弹模态那阵子的入口。阵容页面化之后它只剩兼容职责:
  // 老书签、老深链通过 /bots/roster 复用同一个创建弹窗。
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
      ) : (
        <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
          <Bot size={15} />
          {t('bots.title')}
        </div>
      ),
    [navigate, selectedBot, t],
  );
  useRegisterContentHeader(headerContent);

  useEffect(() => {
    if (selectedBot?.invitation && selectedBot.invitation.stage !== 'ready') return;
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
      void withBotCanonicalSessionReadTimeout(() => sessionService.get(canonicalSessionId))
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
          // observed id so a concurrent recovery still loses the CAS safely.
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
    if (bots.length === 0)
      return (
        <div className="flex flex-1 items-center justify-center">
          <BotCreateMenu label={t('bots.add')} />
        </div>
      );
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

  if (selectedBot.invitation && selectedBot.invitation.stage !== 'ready')
    return (
      <main className="flex h-full items-center justify-center px-6" role="main">
        <BotInvitationWelcome bot={selectedBot} />
      </main>
    );

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
