import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FolderGit2,
  RefreshCcw,
  Settings2,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import * as sessionService from '@/lib/sessionService';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import { getDraft } from '@/state/newMakerDraft';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { useRegisterContentHeader } from '../feature-context';
import {
  applyBotImMigration,
  listBotChannelConnections,
  listBotImMigrations,
  planBotImMigration,
  rollbackBotImMigration,
  setCanonicalBotSession,
  updateBotProfile,
  upsertBotChannel,
  useBotProfiles,
  exportBotBundle,
  importBotBundle,
  type BotCapabilities,
  type BotChannel,
  type BotChannelConnection,
  type BotImMigrationPlan,
  type BotImMigrationRecord,
  type BotProfile,
} from './botStore';
import { BotRosterView } from './BotRosterView';
import { BotAvatar, BotAvatarPicker } from './BotAvatar';
import { BotCapabilitySettings } from './BotCapabilitySettings';
import { BotCapabilityChips } from './BotCapabilityChips';
import { BotProjectSettings } from './BotProjectSettings';
import { BotAutomationSettings } from './BotAutomationSettings';
import { shouldDeferCanonicalBotSessionNavigation } from './botNavigation';
import { BotRouteSettings } from './BotRouteSettings';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotEventInboxSettings } from './BotEventInboxSettings';
import { BotAbilityWall } from './BotAbilityWall';
import { BotFolderCards } from './BotFolderCards';
import { BotGrowthLists } from './BotGrowthLists';
import { BotPersonaWizard, personaSummaryText } from './BotPersonaWizard';
import { extractPersonaFromIdentitySource } from './botPersona';
import { rememberPendingBotPersonaAck } from './botPersonaAck';
import {
  resolveBotSettingsAnchor,
  resolveBotSettingsHighlight,
  type BotSettingsAnchorId,
  type BotSettingsHighlightId,
} from './botSettingsNav';
import type { BotSettingsPayload } from './botSettingsAutosave';
import { useBotSettingsAutosave } from './useBotSettingsAutosave';

/** 成长尾注跳转后的高亮停留时长。 */
const BOT_SETTINGS_HIGHLIGHT_MS = 2400;

function channelLabel(channel: BotChannel): string {
  return channel === 'local' ? 'Local Bot' : channel[0].toUpperCase() + channel.slice(1);
}

/** 区块标题下那句白话（`block-d`）：一个档位、一个颜色，四块保持一致。 */
const BLOCK_DESCRIPTION_CLASS = 'mt-1 text-12 leading-5 text-[var(--text-secondary)]';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * 「今天加入 / 3 天前加入」。
 *
 * 口语相对时长，不是「加入 N 天」——这一行是给「TA 跟了我多久」一个人类回答，不是
 * 一个计数。档位与 `bots.artifacts.time.*` 同一口径（刚刚 / N 天前 / …），只是这里
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

/** Exported for unit tests covering the settings nav / deep-link / tab-grouping behavior. */
export function BotSettings({
  bot,
  onBack,
  onRenew,
  onOpenSession,
  renewing,
}: {
  bot: BotProfile;
  onBack: () => void;
  onRenew: () => Promise<boolean>;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
  renewing: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [settingsSearchParams] = useSearchParams();
  // 批次 β:7 tab 收成一页,`?tab=<id>` 深链变成"滚到某个区块",不再是"切换到某个
  // 面板"。旧 `?settings=1&tab=<value>` 书签仍要落到合理位置——`resolveBotSettingsAnchor`
  // 把旧 7 个 tab id 与新 5 个锚点都映射到同一套结果,未知/缺省值一律回落到页顶(`null`)。
  const anchor = useMemo(
    () => resolveBotSettingsAnchor(settingsSearchParams.get('tab') ?? settingsSearchParams.get('anchor')),
    [settingsSearchParams],
  );
  // 批次 ε:从消息气泡的成长尾注跳进来时,除了滚到「TA 是谁」还要指出**是哪一条**
  // 列表刚长了东西。高亮是一次性的落点提示,几秒后自己退掉——常驻描边会变成噪音。
  const requestedHighlight = useMemo(
    () => resolveBotSettingsHighlight(settingsSearchParams.get('highlight')),
    [settingsSearchParams],
  );
  const [highlight, setHighlight] = useState<BotSettingsHighlightId | null>(requestedHighlight);
  useEffect(() => {
    setHighlight(requestedHighlight);
    if (!requestedHighlight) return;
    const timer = window.setTimeout(() => setHighlight(null), BOT_SETTINGS_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [requestedHighlight]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const anchorRefs = useRef<Record<BotSettingsAnchorId, HTMLElement | null>>({
    who: null,
    can: null,
    understand: null,
    schedule: null,
    advanced: null,
  });
  // "高级" 默认收起;深链直接指向 advanced(旧 capabilities/notifications/advanced
  // 三个 tab 都落在这)时自动展开,否则用户点了才展开。
  const [advancedOpen, setAdvancedOpen] = useState(anchor === 'advanced');
  useEffect(() => {
    if (anchor === 'advanced') setAdvancedOpen(true);
  }, [anchor]);
  useEffect(() => {
    if (!anchor) {
      contentRef.current?.scrollTo({ top: 0 });
      return;
    }
    if (anchor === 'advanced' && !advancedOpen) return; // 等展开状态落定的下一轮再滚
    anchorRefs.current[anchor]?.scrollIntoView({ block: 'start' });
  }, [anchor, advancedOpen]);
  const [personaOpen, setPersonaOpen] = useState(false);
  /**
   * 「刚存完性格，等着回对话」的标记。值用时间戳而不是 boolean：连着调两次性格
   * 也各自能触发一次导航（boolean 会因为值没变而不重跑 effect）。
   */
  const [personaSavedAt, setPersonaSavedAt] = useState<number | null>(null);
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [identitySource, setIdentitySource] = useState(bot.identitySource ?? '');
  const [userContextSource, setUserContextSource] = useState(bot.userContextSource ?? '');
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot.skills);
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelConnections, setChannelConnections] = useState<BotChannelConnection[]>([]);
  const [migrationPlan, setMigrationPlan] = useState<BotImMigrationPlan | null>(null);
  const [migrationRecords, setMigrationRecords] = useState<BotImMigrationRecord[]>([]);
  const [rollbackRecord, setRollbackRecord] = useState<BotImMigrationRecord | null>(null);
  const [profileApplyPrompt, setProfileApplyPrompt] = useState<{
    currentVersion: number;
    activeVersion: number;
  } | null>(null);
  const [profileApplyError, setProfileApplyError] = useState<string | null>(null);
  const [portabilityBusy, setPortabilityBusy] = useState(false);
  const [portabilityNotice, setPortabilityNotice] = useState<string | null>(null);
  const { availableVendors, loaded: availableAgentsLoaded } = useAvailableAgents();
  const selectedProject = bot.projectBindings?.find((binding) => binding.isDefault);
  const sshRemote = Boolean(selectedProject?.remoteHostId);
  const vendor: MakerVendor = capabilities.harness === 'claude' ? 'cc' : capabilities.harness;
  const hiddenVendors = useMemo<MakerVendor[]>(() => {
    if (!availableAgentsLoaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item));
  }, [availableAgentsLoaded, availableVendors]);
  const canonicalProjection = bot.sessions.find((item) => item.kind === 'chat');
  const runtimeState =
    bot.currentVersion !== undefined &&
    canonicalProjection?.profileVersion !== undefined &&
    bot.currentVersion > canonicalProjection.profileVersion
      ? 'pendingRenew'
      : canonicalProjection?.runtimeSnapshot?.status === 'degraded'
        ? 'degraded'
        : canonicalProjection?.runtimeSnapshot?.status === 'failed'
          ? 'failed'
          : canonicalProjection?.runtimeSnapshot?.status === 'prepared'
            ? 'prepared'
            : canonicalProjection?.runtimeSnapshot?.status === 'applied'
              ? 'applied'
              : 'saved';

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

  useEffect(() => {
    let cancelled = false;
    void listBotChannelConnections()
      .then((rows) => {
        if (!cancelled) setChannelConnections(rows.filter((row) => row.accountKey));
      })
      .catch(() => {
        if (!cancelled) setChannelError(t('bots.migration.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, t]);

  useEffect(() => {
    let cancelled = false;
    void listBotImMigrations(bot.id)
      .then((rows) => {
        if (!cancelled) setMigrationRecords(rows);
      })
      .catch(() => {
        if (!cancelled) setChannelError(t('bots.migration.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, t]);

  // 自动保存不再走「点保存」的显式提交,但 Profile 版本落后于当前对话时的
  // 「应用到当前对话」提示仍要给。判定逻辑与手动保存时完全一致,只把**呈现时机**
  // 推到用户离开设置页那一刻(= 他原来会去点保存的那一刻):后台自动保存中途弹模态
  // 会打断正在打字的人,那正是本次要消灭的那类体验。
  const pendingApplyRef = useRef<{ currentVersion: number; activeVersion: number } | null>(null);
  const activeVersionRef = useRef<number | undefined>(canonicalProjection?.profileVersion);
  activeVersionRef.current = canonicalProjection?.profileVersion;

  const commitProfile = useCallback(
    async (payload: BotSettingsPayload) => {
      const updated = await updateBotProfile(bot.id, payload);
      const activeVersion = activeVersionRef.current;
      if (
        updated.currentVersion !== undefined &&
        activeVersion !== undefined &&
        updated.currentVersion > activeVersion
      ) {
        pendingApplyRef.current = {
          currentVersion: updated.currentVersion,
          activeVersion,
        };
      }
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
    setCapabilities((current) => ({ ...current, [key]: value }));
    autosave.onEdit('instant');
  };
  // 子编辑器(能力面板)的回写入口。它一次交互可能同时改 capabilities 与 skills,
  // 两次 onEdit 走同一条合并通道,最终只发一次 IPC。
  const applyCapabilities = (next: BotCapabilities) => {
    setCapabilities(next);
    autosave.onEdit('instant');
  };
  const applySelectedSkills = (next: string[]) => {
    setSelectedSkills(next);
    autosave.onEdit('instant');
  };

  const handleBack = () => {
    setProfileApplyError(null);
    void autosave.flush().then(() => {
      if (autosave.isDirty()) return; // 保存失败:留在页面,状态条给出重试入口
      const pendingApply = pendingApplyRef.current;
      if (pendingApply) {
        pendingApplyRef.current = null;
        setProfileApplyPrompt(pendingApply);
        return;
      }
      onBack();
    });
  };

  /*
    存完性格回对话。放在 effect 里跑，是为了让这一步发生在「新 identitySource 已经
    进了 autosave 载荷 ref」之后 —— 在 onSave 里同步 flush 会保存到旧值。
    handleBack 而不是直接 onBack：保存失败要留在页面，profile 需要重新应用时
    那张确认框也不能被跳过。
  */
  useEffect(() => {
    if (personaSavedAt === null) return;
    setPersonaSavedAt(null);
    handleBack();
    // handleBack 每次渲染都是新函数，挂进依赖会让这个 effect 变成每渲染都跑；
    // 触发条件只有 personaSavedAt 这一个。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaSavedAt]);

  const renewAndApplyProfile = () => {
    setProfileApplyError(null);
    void onRenew().then((renewed) => {
      if (!renewed) setProfileApplyError(t('bots.profileApply.renewFailed'));
    });
  };

  const visibleChannelConnections = useMemo(() => {
    const byKey = new Map<string, BotChannelConnection>();
    for (const connection of channelConnections) {
      if (!connection.accountKey) continue;
      byKey.set(
        `${connection.kind}\u0000${connection.ownership}\u0000${connection.accountKey}`,
        connection,
      );
    }
    for (const channel of bot.channels ?? []) {
      if (channel.kind === 'local') continue;
      const accountKey =
        typeof channel.config?.accountKey === 'string' ? channel.config.accountKey.trim() : '';
      if (!accountKey) continue;
      const ownership =
        channel.config?.ownership === 'server-relay' ? 'server-relay' : 'local-adapter';
      const key = `${channel.kind}\u0000${ownership}\u0000${accountKey}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        id:
          typeof channel.config?.connectionId === 'string'
            ? channel.config.connectionId
            : `saved:${channel.id}`,
        kind: channel.kind,
        ownership,
        status: 'unavailable',
        connected: false,
        accountKey,
        accountName:
          typeof channel.config?.accountName === 'string' ? channel.config.accountName : null,
        scopeKey: typeof channel.config?.scopeKey === 'string' ? channel.config.scopeKey : null,
        routable: true,
        features: Array.isArray(channel.config?.features)
          ? channel.config.features.filter(
              (item): item is BotChannelConnection['features'][number] => typeof item === 'string',
            )
          : [],
      });
    }
    return [...byKey.values()].sort(
      (a, b) =>
        channelLabel(a.kind).localeCompare(channelLabel(b.kind)) ||
        Number(b.connected) - Number(a.connected) ||
        (a.accountName ?? a.accountKey ?? '').localeCompare(b.accountName ?? b.accountKey ?? ''),
    );
  }, [bot.channels, channelConnections]);

  const mountedChannelFor = (connection: BotChannelConnection) =>
    (bot.channels ?? []).find((channel) => {
      if (!channel.enabled || channel.kind !== connection.kind) return false;
      const accountKey =
        typeof channel.config?.accountKey === 'string' ? channel.config.accountKey.trim() : '';
      const ownership =
        channel.config?.ownership === 'server-relay' ? 'server-relay' : 'local-adapter';
      return accountKey === connection.accountKey && ownership === connection.ownership;
    });

  const toggleChannel = async (connection: BotChannelConnection) => {
    if (!connection.accountKey || !connection.routable) return;
    setChannelBusy(connection.id);
    setChannelError(null);
    try {
      const mounted = mountedChannelFor(connection);
      if (mounted) {
        const migration = migrationRecords.find(
          (row) => row.channelId === mounted.id && row.status === 'applied',
        );
        if (migration) {
          setRollbackRecord(migration);
        } else {
          await upsertBotChannel(bot.id, connection.kind, false, mounted.config, mounted.id);
        }
        return;
      }
      setMigrationPlan(await planBotImMigration(bot.id, connection.id));
    } catch {
      setChannelError(t('bots.migration.errors.preflight'));
    } finally {
      setChannelBusy(null);
    }
  };

  const confirmMigration = async () => {
    if (!migrationPlan) return;
    setChannelBusy(migrationPlan.connection.id);
    setChannelError(null);
    try {
      await applyBotImMigration(
        bot.id,
        migrationPlan.connection.id,
        migrationPlan.planHash,
        globalThis.crypto.randomUUID(),
      );
      setMigrationRecords(await listBotImMigrations(bot.id));
      setMigrationPlan(null);
    } catch {
      setChannelError(t('bots.migration.errors.apply'));
    } finally {
      setChannelBusy(null);
    }
  };

  const confirmRollback = async () => {
    if (!rollbackRecord) return;
    setChannelBusy(rollbackRecord.connectionId);
    setChannelError(null);
    try {
      const result = await rollbackBotImMigration(bot.id, rollbackRecord.id);
      setMigrationRecords(await listBotImMigrations(bot.id));
      setRollbackRecord(null);
      const bindingWarning = result.warnings?.find(
        (warning) => warning.code === 'binding-restore-conflict',
      );
      if (bindingWarning) {
        setChannelError(
          t('bots.migration.warnings.binding-restore-conflict', {
            count: bindingWarning.count,
          }),
        );
      }
    } catch {
      setChannelError(t('bots.migration.errors.rollback'));
    } finally {
      setChannelBusy(null);
    }
  };
  const joined = botJoinedRelativeKey(bot.createdAt, Date.now());
  const headerMeta = [description.trim(), joined ? t(joined.key, { n: joined.n }) : '']
    .filter(Boolean)
    .join(' · ');

  if (bot.status === 'archived') {
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)] px-8 py-8" role="main">
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 inline-flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft size={15} />
            {t('bots.title')}
          </button>
          <header className="flex items-center gap-3">
            <BotAvatar bot={bot} size="lg" />
            <div>
              <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                {t('bots.lifecycle.archivedTitle')}
              </p>
              <h1 className="mt-1 text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
              {bot.description ? (
                <p className="mt-1 text-12 text-[var(--text-secondary)]">{bot.description}</p>
              ) : null}
            </div>
          </header>
          <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />
          <BotEventInboxSettings bot={bot} />
        </div>
      </main>
    );
  }
  return (
    <main className="flex h-full flex-col overflow-hidden bg-[var(--surface)]" role="main">
      {/*
        页头与下面的卡片列必须共用同一条左边界。页头此前是整宽 px-8、卡片列是
        mx-auto max-w-3xl —— 窗口一宽，「返回对话 / 头像 / 名字」贴在最左，卡片却
        居中，两条左边界越拉越远，整页读起来像两栏不相干的东西拼在一起。这里给
        页头套上与内容区同宽同居中的容器。
      */}
      <div className="shrink-0 px-8 pb-5 pt-8">
        <div className="mx-auto w-full max-w-3xl">
        <button
          type="button"
          onClick={handleBack}
          className="-ml-2 inline-flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={15} />
          {t('bots.backToChat')}
        </button>
        <header className="mt-3 flex items-center gap-3">
          <BotAvatar bot={{ ...bot, avatar, avatarColor }} size="lg" />
          <div className="min-w-0">
            <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
              {t('bots.settings')}
            </p>
            <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
              {/*
                产品裁决 2026-08-18:设置页头部不挂「放手做」⚠。伙伴不是一个需要
                被随时警告的对象;能力与风险由「TA 会的」那面陈列自己说清楚。
              */}
              {/*
                自动保存的可观测状态。空闲不显示 —— 常驻的「已保存」是噪音,不是信息。
                失败才落到下一行,并自带重试入口。
              */}
              {autosave.status === 'saving' ? (
                <span
                  role="status"
                  className="inline-flex select-none items-center gap-1.5 text-11 text-[var(--text-tertiary)]"
                >
                  <Spinner size={12} />
                  {t('bots.autosave.saving')}
                </span>
              ) : autosave.status === 'saved' ? (
                <span
                  role="status"
                  className="inline-flex select-none animate-fade-in items-center gap-1 text-11 text-[var(--text-tertiary)]"
                >
                  <Check size={12} />
                  {t('bots.autosave.saved')}
                </span>
              ) : null}
            </div>
            {/*
              「{TA 的定位} · 今天加入」。这一行不解释功能,它回答的是「这是谁、跟了
              我多久」——设置页顶上除了名字之外唯一该说的话。定位优先用用户自己写的
              描述,没有就退回到这个伙伴擅长什么(描述是可空字段,不为它造一句)。
            */}
            {headerMeta ? (
              <p className="mt-1 text-12 leading-5 text-[var(--text-tertiary)]">{headerMeta}</p>
            ) : null}
            {autosave.status === 'error' ? (
              <p
                className="mt-1 flex flex-wrap items-center gap-2 text-11 text-[var(--text-danger)]"
                role="alert"
              >
                {t('bots.profileApply.saveFailed')}
                <button
                  type="button"
                  onClick={() => void autosave.retry()}
                  className="rounded-lg px-1.5 py-0.5 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.autosave.retry')}
                </button>
              </p>
            ) : profileApplyError ? (
              <p className="mt-1 text-11 text-[var(--text-danger)]" role="alert">
                {profileApplyError}
              </p>
            ) : null}
          </div>
        </header>
        </div>
      </div>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 pb-10">
          {/* "TA 是谁" */}
          <section
            ref={(el) => {
              anchorRefs.current.who = el;
            }}
            className="scroll-mt-6 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
          >
            <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
              <UserRound size={16} />
              {t('bots.settingsBlocks.who')}
            </div>
            {/* 每块标题下面一句白话。四个区块的标题都是「TA 怎样怎样」,不说清楚这
                一块要用户做什么,人会以为四块都得填一遍。 */}
            <p className={BLOCK_DESCRIPTION_CLASS}>{t('bots.settingsBlocks.whoDescription')}</p>
            <div className="mt-4 flex items-center gap-3">
              <BotAvatarPicker
                name={name}
                avatar={avatar}
                avatarColor={avatarColor}
                onChange={(next) => {
                  setAvatar(next.emoji);
                  setAvatarColor(next.hue);
                  autosave.onEdit('instant');
                }}
              />
              <div className="min-w-0 flex-1">
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    autosave.onEdit('text');
                  }}
                  onBlur={() => void autosave.flush()}
                  aria-label={t('bots.nameLabel')}
                  className="h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                />
                {/* 「消息入口: Local Bot」下沉到高级。这张卡回答的是「TA 是谁」,
                    而 Local Bot 是实现词——它说的是这个 Profile 挂在哪条投递链上,
                    不是这个伙伴的身份。 */}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--surface-chip)] px-3 py-2.5">
              <p className="min-w-0 flex-1 text-12 text-[var(--text-primary)]">
                {personaSummaryText(t, extractPersonaFromIdentitySource(identitySource))}
              </p>
              <button
                type="button"
                onClick={() => setPersonaOpen(true)}
                className="h-8 shrink-0 rounded-lg border border-[var(--border-default)] px-3 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.persona.adjustButton')}
              </button>
            </div>

            {/* "TA 记得的" + "TA 学会的" — memory=false 的历史伙伴留一条自己开回来的
                路,恒开后走真实的 bot-memory 只读枚举 + 单删 + 清空。记忆关掉时两个
                列表一起消失:没有记忆分域,伙伴也长不出本事。 */}
            <div className="mt-5 border-t border-[var(--border-default)] pt-4">
              {capabilities.memory ? (
                <BotGrowthLists botId={bot.id} highlight={highlight} />
              ) : (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-3">
                  <span className="min-w-0">
                    <span className="block text-12 font-medium text-[var(--text-primary)]">
                      {t('bots.memoryRecovery.title')}
                    </span>
                    <span className="mt-0.5 block text-11 leading-4 text-[var(--text-tertiary)]">
                      {t('bots.memoryRecovery.description')}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => updateCapability('memory', true)}
                    className="h-8 shrink-0 rounded-lg border border-[var(--border-default)] px-3 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    {t('bots.memoryRecovery.action')}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* "TA 会的" */}
          <section
            ref={(el) => {
              anchorRefs.current.can = el;
            }}
            className="scroll-mt-6 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
          >
            <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
              <Sparkles size={16} />
              {t('bots.settingsBlocks.can')}
            </div>
            <p className={BLOCK_DESCRIPTION_CLASS}>{t('bots.settingsBlocks.canDescription')}</p>
            <div className="mt-4">
              <BotAbilityWall
                connections={visibleChannelConnections}
                isChannelMounted={(connection) => Boolean(mountedChannelFor(connection))}
                channelBusyId={channelBusy}
                onToggleChannel={(connection) => void toggleChannel(connection)}
              />
            </div>
            {channelError ? (
              <p className="mt-3 text-11 text-[var(--text-danger)]">{channelError}</p>
            ) : null}
          </section>

          {/* "TA 懂的" */}
          <section
            ref={(el) => {
              anchorRefs.current.understand = el;
            }}
            className="scroll-mt-6 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
          >
            <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
              <FolderGit2 size={16} />
              {t('bots.settingsBlocks.understand')}
            </div>
            <p className={BLOCK_DESCRIPTION_CLASS}>
              {t('bots.settingsBlocks.understandDescription')}
            </p>
            <div className="mt-4">
              <BotFolderCards botId={bot.id} bindings={bot.projectBindings ?? []} />
            </div>
          </section>

          {/* "TA 的日程" — 整体嵌入,不再要求「先开自动化」;首次创建 Routine 通过
              onEnableAutomation 走自动保存把 capabilities.automation 悄悄翻开。 */}
          <div
            ref={(el) => {
              anchorRefs.current.schedule = el;
            }}
            className="scroll-mt-6"
          >
            <BotAutomationSettings
              bot={bot}
              enabled={bot.capabilities.automation}
              trusted={bot.capabilities.permissions === 'trusted'}
              onOpenTask={onOpenSession}
              onEnableAutomation={() => updateCapability('automation', true)}
            />
          </div>

          {/* "高级" — 单个文字链接展开的内联区块,不是弹窗;深链 ?tab=advanced 及旧
              7-tab 里落在这里的 capabilities/notifications 会在挂载时自动展开。 */}
          <section
            ref={(el) => {
              anchorRefs.current.advanced = el;
            }}
            className="scroll-mt-6"
          >
            <button
              type="button"
              onClick={() => setAdvancedOpen((current) => !current)}
              aria-expanded={advancedOpen}
              className="inline-flex items-center gap-1 text-12 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {/* 一个方向指示就够。文案里原来还留着一个「›」,和这个 chevron 指的方向
                  不一样,两个箭头打架。 */}
              {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {t('bots.advancedLinkLabel')}
            </button>

            {advancedOpen ? (
              <div className="mt-4 flex flex-col gap-5">
                <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
                  <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
                    <Settings2 size={16} />
                    {t('bots.advancedIdentity.title')}
                  </div>
                  <p className="mt-1 text-11 text-[var(--text-tertiary)]">
                    {t('bots.channelLabel')}: {channelLabel(bot.channel)}
                  </p>
                  <label className="mt-4 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                    {t('bots.descriptionLabel')}
                    <textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                        autosave.onEdit('text');
                      }}
                      onBlur={() => void autosave.flush()}
                      rows={3}
                      className="resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                    />
                  </label>
                  <label className="mt-4 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                    {t('bots.userContextSourceLabel')}
                    <textarea
                      value={userContextSource}
                      onChange={(event) => {
                        setUserContextSource(event.target.value);
                        autosave.onEdit('text');
                      }}
                      onBlur={() => void autosave.flush()}
                      placeholder={t('bots.userContextSourcePlaceholder')}
                      rows={4}
                      className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                    />
                    <span className="text-11 leading-5 text-[var(--text-tertiary)]">
                      {t('bots.userContextSourceDescription')}
                    </span>
                  </label>
                </section>

                <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
                  <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
                    <Sparkles size={16} />
                    {t('bots.advancedCapabilities.title')}
                  </div>
                  <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                    {t('bots.advancedCapabilities.description')}
                  </p>
                  <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                      <span>{t('bots.harnessLabel')}</span>
                      <VendorSegmentedSwitcher
                        value={vendor}
                        hiddenVendors={hiddenVendors}
                        dense
                        width={300}
                        className="max-w-full"
                        ariaLabel={t('bots.harnessLabel')}
                        onChange={(next) => {
                          if (next === 'orca') return;
                          const prefs = getDraft().lastByVendor[next];
                          setCapabilities((current) => ({
                            ...current,
                            harness: next === 'cc' ? 'claude' : next,
                            model: prefs.model,
                            providerId: prefs.providerId ?? null,
                            effort: prefs.effort,
                            fastMode: getDraft().fastModeByModel[prefs.model] === true,
                            skillMode: 'inherit',
                          }));
                          autosave.onEdit('instant');
                        }}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                      <span>{t('bots.modelLabel')}</span>
                      <ModelSelector
                        modelId={capabilities.model}
                        effort={capabilities.effort}
                        vendorKey={vendor}
                        currentProviderId={capabilities.providerId ?? null}
                        triggerVariant="field"
                        popoverSide="bottom"
                        ariaContext={t('bots.modelLabel')}
                        excludeSubscriptionDirect={sshRemote}
                        excludeChatBridgedCodex={sshRemote}
                        fastMode={vendor === 'cc' ? undefined : capabilities.fastMode}
                        onFastModeChange={
                          vendor === 'cc'
                            ? undefined
                            : (enabled) => updateCapability('fastMode', enabled)
                        }
                        onModelChange={(model) => updateCapability('model', model)}
                        onEffortChange={(effort) => updateCapability('effort', effort)}
                        onProviderChange={(providerId, model, effort) => {
                          setCapabilities((current) => ({
                            ...current,
                            providerId,
                            model: model ?? current.model,
                            effort: effort || current.effort,
                          }));
                          autosave.onEdit('instant');
                        }}
                        onNavigateToProviders={() => navigate('/settings?tab=providers')}
                        unknownModelLabel={(model) => t('bots.modelUnavailable', { model })}
                      />
                    </div>
                  </div>
                  <BotCapabilitySettings
                    bot={bot}
                    capabilities={capabilities}
                    selectedSkills={selectedSkills}
                    runtimeSnapshot={canonicalProjection?.runtimeSnapshot}
                    remoteHostId={selectedProject?.remoteHostId}
                    onCapabilitiesChange={applyCapabilities}
                    onSelectedSkillsChange={applySelectedSkills}
                  />
                </section>

                <BotCapabilityChips
                  capabilities={capabilities}
                  onCapabilitiesChange={applyCapabilities}
                  connections={visibleChannelConnections}
                  isChannelMounted={(connection) => Boolean(mountedChannelFor(connection))}
                  channelBusyId={channelBusy}
                  onToggleChannel={(connection) => void toggleChannel(connection)}
                  headerAside={
                    <span className="rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-10 text-[var(--text-secondary)]">
                      {t(`bots.runtimeState.${runtimeState}`)}
                    </span>
                  }
                >
                  <p className="mt-4 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-5 text-[var(--text-secondary)]">
                    {t('bots.capabilitiesDeferred')}
                  </p>
                  {channelError ? (
                    <p className="mt-3 text-11 text-[var(--text-danger)]">{channelError}</p>
                  ) : null}
                </BotCapabilityChips>

                <BotRouteSettings bot={bot} onOpenTask={onOpenSession} />

                <BotProjectSettings bot={bot} />

                <BotEventInboxSettings bot={bot} />

                <section className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
                  <div>
                    <p className="text-13 font-medium text-[var(--text-primary)]">
                      {t('bots.sessionLifecycleTitle')}
                    </p>
                    <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                      {t('bots.sessionLifecycleDescription')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={renewAndApplyProfile}
                    disabled={renewing}
                    className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    <RefreshCcw size={14} className={renewing ? 'animate-spin' : undefined} />
                    {renewing ? t('bots.renewing') : t('bots.renew')}
                  </button>
                </section>

                <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />

                <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
                  <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
                    <Download size={16} />
                    {t('bots.portability.title')}
                  </div>
                  <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                    {t('bots.portability.description')}
                  </p>
                  {portabilityNotice ? (
                    <p
                      className="mt-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-5 text-[var(--text-secondary)]"
                      role="status"
                    >
                      {portabilityNotice}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    disabled={portabilityBusy}
                    onClick={() => {
                      setPortabilityBusy(true);
                      setPortabilityNotice(null);
                      void exportBotBundle(bot.id)
                        .then((result) => {
                          if (!result.canceled) {
                            setPortabilityNotice(
                              result.redactionCount
                                ? t('bots.portability.exportedRedacted', {
                                    count: result.redactionCount,
                                  })
                                : t('bots.portability.exported'),
                            );
                          }
                        })
                        .catch((error: unknown) => {
                          setPortabilityNotice(
                            error instanceof Error ? error.message : String(error),
                          );
                        })
                        .finally(() => setPortabilityBusy(false));
                    }}
                    className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    <Download size={14} />
                    {portabilityBusy
                      ? t('bots.portability.exporting')
                      : t('bots.portability.export')}
                  </button>
                </section>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <BotPersonaWizard
        open={personaOpen}
        identitySource={identitySource}
        onOpenChange={setPersonaOpen}
        onSave={(next) => {
          /*
            调完性格要能立刻**听见**新口气，所以这里做两件事：
            1) 人格真的变了才寄存一条确认消息(botPersonaAck，幂等靠 clientId)；
            2) 回到 TA 的对话 —— 「调整性格」是从对话里点进来的，改完停在设置页
               等于让用户自己再点一次返回才看得到效果。

            导航**不能**在这里同步做：autosave 的载荷是每次渲染写进 ref 的，
            此刻 setIdentitySource 还没提交，同步 flush 会把**旧的** identitySource
            当成要保存的内容发出去 —— 性格白调了。改成置一个标记，等新草稿落进
            ref 之后的那次渲染再走 handleBack。
          */
          const previous = extractPersonaFromIdentitySource(identitySource);
          const parsed = extractPersonaFromIdentitySource(next);
          setIdentitySource(next);
          autosave.onEdit('instant');
          if (parsed) rememberPendingBotPersonaAck(bot.id, previous, parsed);
          setPersonaSavedAt(Date.now());
        }}
      />

      {/*
        挂载 / 卸载渠道现在同时来自「TA 会的」墙与高级里的能力芯片墙,所以迁移与
        回滚确认必须挂在页面根上——两处都可能触发,任何一处都不能因为「高级」当前
        收起就吞掉确认框,用户会看到「点了没反应」。
      */}
      <Dialog.Root
        open={migrationPlan !== null}
        onOpenChange={(open) => {
          if (!open && channelBusy === null) setMigrationPlan(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('bots.migration.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.migration.description')}
            </Dialog.Description>
            {migrationPlan ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl bg-[var(--surface-chip)] p-3 text-12 text-[var(--text-secondary)]">
                  <p className="font-medium text-[var(--text-primary)]">
                    {channelLabel(migrationPlan.connection.kind)} ·{' '}
                    {migrationPlan.connection.accountName ||
                      migrationPlan.connection.accountKey}
                  </p>
                  <p className="mt-1">
                    {t('bots.migration.legacyTaskCount', {
                      count: migrationPlan.candidates.length,
                    })}
                  </p>
                </div>
                {migrationPlan.conflicts.length > 0 ? (
                  <div className="rounded-xl border border-[var(--text-danger)]/30 bg-[var(--surface-chip)] p-3">
                    <p className="text-12 font-medium text-[var(--text-danger)]">
                      {t('bots.migration.blocked')}
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-11 text-[var(--text-secondary)]">
                      {migrationPlan.conflicts.map((conflict, index) => (
                        <li key={`${conflict.code}:${conflict.sessionId ?? index}`}>
                          {t(`bots.migration.conflicts.${conflict.code}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {migrationPlan.warnings.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-11 text-[var(--text-secondary)]">
                    {migrationPlan.warnings.map((warning) => (
                      <li key={warning.code}>
                        {t(`bots.migration.warnings.${warning.code}`)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-11 leading-5 text-[var(--text-tertiary)]">
                  {t('bots.migration.preserveData')}
                </p>
              </div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={channelBusy !== null}
                onClick={() => setMigrationPlan(null)}
                className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.cancel')}
              </button>
              <button
                type="button"
                disabled={!migrationPlan?.canApply || channelBusy !== null}
                onClick={() => void confirmMigration()}
                className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
              >
                {channelBusy ? t('bots.migration.applying') : t('bots.migration.apply')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={rollbackRecord !== null}
        onOpenChange={(open) => {
          if (!open && channelBusy === null) setRollbackRecord(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('bots.migration.rollbackTitle')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.migration.rollbackDescription')}
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={channelBusy !== null}
                onClick={() => setRollbackRecord(null)}
                className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.cancel')}
              </button>
              <button
                type="button"
                disabled={channelBusy !== null}
                onClick={() => void confirmRollback()}
                className="h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                {channelBusy
                  ? t('bots.migration.rollingBack')
                  : t('bots.migration.rollback')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={profileApplyPrompt !== null}
        onOpenChange={(open) => {
          if (!open && !renewing) setProfileApplyPrompt(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('bots.profileApply.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
              {profileApplyPrompt
                ? t('bots.profileApply.description', {
                    currentVersion: profileApplyPrompt.currentVersion,
                    activeVersion: profileApplyPrompt.activeVersion,
                  })
                : null}
            </Dialog.Description>
            {profileApplyError ? (
              <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
                {profileApplyError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={renewing}
                onClick={() => {
                  setProfileApplyPrompt(null);
                  onBack();
                }}
                className="h-8 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                {t('bots.profileApply.keepCurrent')}
              </button>
              <button
                type="button"
                disabled={renewing}
                onClick={renewAndApplyProfile}
                className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50"
              >
                <RefreshCcw size={14} className={renewing ? 'animate-spin' : undefined} />
                {renewing ? t('bots.renewing') : t('bots.profileApply.renewAndApply')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

export function BotsHomeView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const bots = useBotProfiles();
  const creatingBotRef = useRef<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<unknown>(null);
  const importingRef = useRef(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const selectedBot = useMemo(() => bots.find((bot) => bot.id === botId) ?? null, [botId, bots]);
  // `?add=1` 是阵容还在弹模态那阵子的入口。阵容页面化之后它只剩兼容职责:
  // 老书签、老深链一律送到 /bots/roster,不再在这里开一层浮层。
  const addRequested = searchParams.get('add') === '1';
  const settingsOpen = searchParams.get('settings') === '1';

  const createCanonicalSession = useCallback(
    async (
      bot: BotProfile,
      expectedCanonicalSessionId: string | null = bot.canonicalSessionId ?? null,
      recoverMissingOnly = false,
    ): Promise<import('@/lib/ccAgent.types').Session> => {
      try {
        setCreateSessionError(null);
        const result = await window.electronAPI.localDb.bots.createCanonicalSession({
          botId: bot.id,
          expectedCanonicalSessionId,
          expectedProfileVersion: bot.currentVersion ?? 1,
          recoverMissingOnly,
        });
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

  const renewBotSession = useCallback(
    async (bot: BotProfile): Promise<boolean> => {
      setIsCreatingSession(true);
      try {
        const next = await createCanonicalSession(bot);
        if (!next) return false;
        navigate(`/bots/${bot.id}/session/${next.id}`, { replace: true });
        return true;
      } catch {
        // The settings view remains mounted and can surface a localized error.
        return false;
      } finally {
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

  // 顶栏注入区:选中伙伴时是「头像 + 名字」,点它进 TA 的设置(与对话顶栏同一入口
  // 语义);没有选中伙伴才退回功能名。
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
    if (searchParams.get('import') !== '1' || importingRef.current) return;
    importingRef.current = true;
    setSearchParams(
      (current) => {
        current.delete('import');
        return current;
      },
      { replace: true },
    );
    void importBotBundle()
      .then((result) => {
        if (result.canceled) return;
        setImportNotice(
          t('bots.portability.imported', {
            channels: result.disabledChannels?.length ?? 0,
            automations: result.pausedAutomations ?? 0,
          }),
        );
        if (result.botId) navigate(`/bots/${result.botId}?settings=1`, { replace: true });
      })
      .catch((error: unknown) => {
        setImportNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        importingRef.current = false;
      });
  }, [navigate, searchParams, setSearchParams, t]);

  useEffect(() => {
    if (
      !selectedBot ||
      shouldDeferCanonicalBotSessionNavigation({ settingsOpen, addRequested })
    )
      return;
    if (selectedBot.status !== 'active') {
      navigate(`/bots/${selectedBot.id}?settings=1`, { replace: true });
      return;
    }

    const canonicalSessionId = selectedBot.canonicalSessionId;
    let cancelled = false;
    if (canonicalSessionId) {
      setIsCreatingSession(false);
      void sessionService
        .get(canonicalSessionId)
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
            id: canonicalSessionId,
            title: session.title || selectedBot.name,
            updatedAt: Date.parse(session.updatedAt) || Date.now(),
          });
          if (!cancelled && sessionId !== canonicalSessionId) {
            navigate(`/bots/${selectedBot.id}/session/${canonicalSessionId}`, { replace: true });
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
      return;
    }

    if (sessionId || creatingBotRef.current === selectedBot.id) return;

    creatingBotRef.current = selectedBot.id;
    setIsCreatingSession(true);
    void createCanonicalSession(selectedBot)
      .then((session) => {
        if (cancelled) return;
        setIsCreatingSession(false);
        if (!session) {
          creatingBotRef.current = null;
          return;
        }
        navigate(`/bots/${selectedBot.id}/session/${session.id}`, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        setIsCreatingSession(false);
        creatingBotRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [
    addRequested,
    createCanonicalSession,
    selectedBot,
    sessionId,
    settingsOpen,
    navigate,
  ]);

  if (!selectedBot) {
    // 一个伙伴都没有 → 主区直接就是阵容页,没有中间那一层。
    //
    // 这里曾经是另一套「还没有伙伴」推销页:Bot 图标 + 四张功能卖点卡（长期身份 /
    // 自动接收任务事件 / 自动化与协同 / 按需挂载消息通道）+ 一个「添加伙伴」按钮,
    // 点了才弹出阵容模态。它用产品内部术语介绍一个本来靠「挑一个合拍的」就能懂的
    // 东西,还把定稿最重要的第一印象藏在两层之后。整页删除,不做兼容。
    if (bots.length === 0) return <BotRosterView notice={importNotice} />;
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
      <>
        <BotSettings
          // 切到另一个 Bot 必须重挂:自动保存的基线、防抖计时与「未落即冲刷」都绑在
          // 实例上,复用实例会让上一个 Bot 的待保存改动记在新 Bot 头上。
          key={selectedBot.id}
          bot={selectedBot}
          onRenew={() => renewBotSession(selectedBot)}
          onOpenSession={(targetSessionId, searchJump) => {
            const projection = selectedBot.sessions.find((item) => item.id === targetSessionId);
            const route =
              projection?.kind === 'history'
                ? `/bots/${selectedBot.id}/history/${targetSessionId}`
                : `/bots/${selectedBot.id}/session/${targetSessionId}`;
            navigate(route, { state: searchJump ? { searchJump } : undefined });
          }}
          renewing={isCreatingSession}
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
      </>
    );
  }

  return (
    <main className="flex h-full items-center justify-center bg-[var(--surface)]" role="main">
      {importNotice || (createSessionError && !isCreatingSession) ? (
        <p className="max-w-lg px-6 text-center text-13 text-[var(--text-secondary)]">
          {importNotice ?? t('ccAgent.draft.createSessionFailed')}
        </p>
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
