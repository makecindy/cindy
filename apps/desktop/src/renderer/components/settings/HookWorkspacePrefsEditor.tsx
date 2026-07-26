/**
 * HookWorkspacePrefsEditor —— 工作目录卡片内嵌的会话偏好编辑行。
 *
 * 由 HookConnectionsSection 在每个目录卡片下渲染(用户反馈: 偏好属于目录
 * 条目本身, 不该是独立区块): agent / 模型(含思考强度) / 权限模式三个字段。
 *
 * **三个控件一律复用应用标准选择器,本文件不自建任何选择 UI**(2026-07 用户
 * 定稿: 这里曾私搭一套裸下拉, 露出 'claude-code' 原始 id、自己拼一遍可选模型
 * 清单、effort 直接显示未经 i18n 的 low/medium/high):
 *   - agent   -> VendorSegmentedSwitcher(品牌分段 pill, 与首页新建对话同一个)
 *   - 模型    -> ModelSelector 的 field trigger, **composer 同款全功能形态**(供应商
 *                分段/订阅来源/推理强度全开; 2026-07 用户定稿基准: 全软件一个模型
 *                选择面板, 处处同行为, 差异只有样式)。来源落本地
 *                workspaceProviderSourceStore, model/effort 照旧走 server prefs
 *   - 权限    -> PermissionSelector 的 field trigger
 * 思考强度不再是独立控件 —— 它并进模型 trigger 显示成「模型名 · 档位」, 与
 * 隔壁 ImDefaultSettingsSection(IM 新会话默认)和会话输入框成一套。
 *
 * 未显式设置的字段**解析出当前真正会生效的默认值**直接展示, 界面上不暴露
 * 「默认」概念(无后缀 / 无弱化色 / 无「恢复默认」菜单项 —— 用户反馈: 不要
 * 有 xxx(默认)这种); 选中任一项即写显式偏好。解析链与 main 侧 defaults.ts
 * 逐字段对齐(resolveEffectiveRow, 纯函数有单测), 数据源是 imDefaultSettingsGet
 * (**频道随 provider**: Slack 读 channels.slack, Telegram 读 global, 与派发侧
 * session-runner 同源)+ 本机 capabilities。权限档另经
 * resolveEffectivePermissionMode 校准: 无显式偏好 → bypassPermissions(无人值守
 * 历史默认), 显式档不被当前 agent 支持 → 该 agent 最严档(绝不放宽)。
 *
 * 数据正本在 IM hook server 的 provider prefs 表：Slack 与 Telegram 按
 * provider 隔离；每个 provider 内与其 /model 卡使用同一份数据。hook 经
 * provider 对应的 IPC 走 WS 往返读写，命令卡改动经 provider 状态推送实时
 * 同步。写入的联动校准(换 agent 清模型、换模型校准 effort)仍走
 * hookWorkspacePrefsLogic.ts 的纯函数, 与 Slack /model 卡逐字段同语义。
 *
 * 状态模型(禁用整体置灰而非增删行, 规则 7):
 *   - 连接未就绪 -> 禁用(提示行由宿主渲染一次, 不逐卡重复)
 *   - 已连接但未绑定 -> 禁用 + 「先完成绑定」
 *   - HOOK_PREFS_TIMEOUT -> 禁用 + 「服务器版本过旧」+ 重试
 * 颜色一律走主题 token(规则 16)。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useAgentCapabilities, type AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import type { MakerVendor } from '@/lib/ccAgent.types';
import {
  getProviderModelEffort,
  setProviderModelChoice,
  setProviderModelEffort,
  getProviderModelFast,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import type {
  HookPrefsPatch,
  HookPrefsView,
  HookWorkspacePrefs,
  HookWorkspaceProviderSourceEntry,
  ProviderPrefsView,
  SlackHookView,
} from '../../../shared/hookControlIpc';
import type { ImDefaultSettingsState } from '../../../shared/imDefaultSettings';
import {
  AGENT_KINDS,
  HOOK_DEFAULT_PERMISSION_MODE,
  isKnownAgent,
  patchForAgentChange,
  patchForModelChange,
  resolveEffectiveRow,
  type ImDefaultsLike,
  type KnownAgent,
  type PrefsAgentCaps,
} from './hookWorkspacePrefsLogic';

/** 全 null 的缺省偏好行(该目录从未设置过)。 */
function emptyPrefs(workspace: string): HookWorkspacePrefs {
  return { workspace, model: null, effort: null, agentKind: null, permissionMode: null };
}

function toPrefsCaps(caps: AgentCapabilities | null): PrefsAgentCaps | null {
  if (caps === null) return null;
  return {
    models: caps.availableModels.map((m) => ({
      id: m.id,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    })),
    permissionModes: caps.permissionModes.map((pm) => ({ id: pm.id })),
  };
}

export interface HookWorkspacePrefsState {
  /** 按别名查该目录偏好(无行返回全 null 缺省; multi-team 下按选中 team 过滤)。 */
  prefsFor: (alias: string) => HookWorkspacePrefs;
  /** 该目录的模型来源偏好(纯本地; null = 未设置, 跟随默认路由)。 */
  providerSourceFor: (alias: string) => string | null;
  /** 写/清该目录的模型来源偏好(providerId = null 清除)。 */
  applyProviderSource: (alias: string, providerId: string | null) => void;
  /** 是否可编辑(已连接 + 已绑定 + 快照可用)。 */
  editable: boolean;
  /** 写入在途的目录别名(该卡片下拉禁用)。 */
  pendingWs: string | null;
  /** 不可编辑的原因提示(null = 无需提示); 宿主渲染一次。 */
  hint: string | null;
  /** hint 为「服务器过旧」时提供的重试入口(其余为 null)。 */
  retry: (() => void) | null;
  /** 桌面新会话默认设置(解析「当前生效默认值」的数据源; 未就绪为 null)。 */
  imDefaults: ImDefaultsLike | null;
  /** alsoProviderSource: 远端写成功后串联落本地来源(undefined = 不动来源)。 */
  applyPatch: (
    workspace: string,
    patch: HookPrefsPatch,
    alsoProviderSource?: string | null,
  ) => void;
  /** (multi-team)可用绑定清单(未 displaced); 单绑定/老 server 时 ≤1 条。 */
  teams: Array<{ teamId: string; teamName: string | null }>;
  /** 当前偏好归属 team(teams 非空时必有值; 选中项失效自动回落首个)。 */
  selectedTeamId: string | null;
  selectTeam: (teamId: string) => void;
  /** 是否显示 team 切换 chip(server multi-team 且 ≥2 个可用绑定)。 */
  showTeamChip: boolean;
}

export type HookPrefsProvider = 'slack' | 'telegram';

function isProviderPrefsView(view: HookPrefsView | ProviderPrefsView): view is ProviderPrefsView {
  return 'provider' in view;
}

/**
 * 目录偏好共享状态(单订阅): 拉取/写入/推送同步 + 禁用态归纳。
 * hook 传 null 时(数据未就绪)一切禁用无提示。
 */
export function useHookWorkspacePrefs(
  hook: SlackHookView | null,
  provider: HookPrefsProvider = 'slack',
): HookWorkspacePrefsState {
  const { t } = useTranslation();
  const [prefsView, setPrefsView] = useState<HookPrefsView | ProviderPrefsView | null>(null);
  /** 'unavailable' = 快照读不到(server 太旧 / 通道缺失 / 内部错), 提示 + 重试。 */
  const [loadError, setLoadError] = useState<'unavailable' | null>(null);
  const [pendingWs, setPendingWs] = useState<string | null>(null);
  const [imDefaults, setImDefaults] = useState<ImDefaultsLike | null>(null);
  // 目录模型来源偏好(纯本地文件, 不经 WS): 全量条目一次拉取, 写后用返回值刷新。
  const [providerSources, setProviderSources] = useState<HookWorkspaceProviderSourceEntry[]>([]);
  // latest-wins 守卫(Copilot review): 快速连选/跨窗口广播时, 较慢的旧回复不得覆盖新状态。
  const providerSourceRevisionRef = useRef(0);
  const telegramBindingId =
    provider === 'telegram' && hook?.telegram.binding?.state === 'confirmed'
      ? hook.telegram.binding.bindingId
      : null;
  const connected =
    provider === 'telegram'
      ? hook?.telegram.enabled === true &&
        hook.telegram.available &&
        hook.telegram.status === 'connected'
      : hook?.enabled === true && hook.status === 'connected';
  const providerBindingConfirmed =
    provider !== 'telegram' || hook?.telegram.binding?.state === 'confirmed';
  const readyIdentity =
    connected && providerBindingConfirmed
      ? provider === 'telegram'
        ? telegramBindingId === null
          ? null
          : `telegram:${telegramBindingId}`
        : 'slack'
      : null;
  // Initialised to null (never a real identity) so the ready-edge effect below
  // is the single fetch trigger: it performs the first fetch on mount only when
  // the provider is actually reachable, and cannot double-fetch with a separate
  // mount effect (issue #279 review).
  const lastReadyIdentityRef = useRef<string | null>(null);
  const fetchRevisionRef = useRef(0);
  const mutationRevisionRef = useRef(0);
  const telegramBindingIdRef = useRef<string | null>(telegramBindingId);
  telegramBindingIdRef.current = telegramBindingId;

  const fetchPrefs = useCallback(async () => {
    const revision = ++fetchRevisionRef.current;
    try {
      const res =
        provider === 'telegram'
          ? await window.electronAPI.hookControl.getProviderWorkspacePrefs()
          : await window.electronAPI.hookControl.getWorkspacePrefs();
      if (revision !== fetchRevisionRef.current) return;
      const nextPrefs: HookPrefsView | ProviderPrefsView = res.prefs;
      if (
        provider === 'telegram' &&
        (!isProviderPrefsView(nextPrefs) ||
          nextPrefs.provider !== 'telegram' ||
          nextPrefs.bindingId !== telegramBindingIdRef.current)
      ) {
        return;
      }
      if (provider === 'slack' && isProviderPrefsView(nextPrefs)) return;
      setPrefsView(nextPrefs);
      setLoadError(null);
    } catch (err) {
      if (revision !== fetchRevisionRef.current) return;
      const code = extractIpcError(err)?.code;
      // HOOK_NOT_CONNECTED 静默(连接态提示由 requireConnected 分支呈现);
      // 其余一律进 unavailable —— 绝不让下拉无解释地死着(超时 = server 太旧,
      // 通道不存在 = 桌面端 main 未重启到新版, 都给同一句提示 + 重试)
      if (code !== 'HOOK_NOT_CONNECTED') setLoadError('unavailable');
    }
  }, [provider]);

  useEffect(() => {
    let active = true;
    const applyIncoming = (view: HookPrefsView | ProviderPrefsView) => {
      if (provider === 'telegram') {
        if (
          !isProviderPrefsView(view) ||
          view.provider !== 'telegram' ||
          view.bindingId !== telegramBindingIdRef.current
        ) {
          return;
        }
      } else if (isProviderPrefsView(view)) {
        return;
      }
      // /model 卡改动 / 其它窗口写入的实时同步(全量快照 latest-wins)
      fetchRevisionRef.current += 1;
      setPrefsView(view);
      setLoadError(null);
    };
    const offPrefs =
      provider === 'telegram'
        ? window.electronAPI.hookControl.onProviderPrefsChanged((view) => {
            if (view.provider === 'telegram') applyIncoming(view);
          })
        : window.electronAPI.hookControl.onPrefsChanged(applyIncoming);
    // The ready-edge effect below performs the initial prefs fetch (only when
    // reachable). The subscription set up here just needs to exist first so no
    // server push is missed before that fetch resolves.
    // 桌面新会话默认设置: 未显式设置字段的生效值解析源, 面板打开时取一次即可。
    // **频道必须与派发侧同源**: session-runner 用
    // `readImDefaultSettings(sourceIm === 'slack' ? 'slack' : undefined)` —— Slack 读
    // channels.slack, Telegram 读 global, 两者各自独立归一化互不继承
    // (im/defaultSettingsStore.ts; IM_DEFAULT_SETTINGS_CHANNELS 里根本没有 telegram)。
    // 这里原先两个 provider 都写死 'slack', 于是 Telegram 卡片下的目录行显示的是
    // Slack 频道的 agent/模型, 派发实际用 global —— 显示与实际不符(2026-07 实审发现)。
    void window.electronAPI.maker
      .imDefaultSettingsGet(provider === 'slack' ? 'slack' : undefined)
      .then((state: ImDefaultSettingsState) => {
        if (active) setImDefaults({ agentKind: state.agentKind, agents: state.agents });
      })
      .catch(() => {});
    // 初次拉取同样受 latest-wins 守卫(Copilot review): 回复未归时若已收到其它
    // 窗口的写入广播(revision 已前进), 旧快照不得回滚新状态。
    const initialSourcesRevision = providerSourceRevisionRef.current;
    void window.electronAPI.hookControl
      .getWorkspaceProviderSources()
      .then((res) => {
        if (active && providerSourceRevisionRef.current === initialSourcesRevision) {
          setProviderSources(res.entries);
        }
      })
      .catch(() => {});
    // 多窗口同步(codex review): 会话副窗也能开设置页, 其它窗口写入时以广播的
    // 全量条目为准刷新(与 prefs.state 的 latest-wins 快照语义一致)。
    const offProviderSources = window.electronAPI.hookControl.onWorkspaceProviderSourcesChanged(
      (entries) => {
        providerSourceRevisionRef.current += 1;
        setProviderSources(entries);
      },
    );
    return () => {
      active = false;
      fetchRevisionRef.current += 1;
      mutationRevisionRef.current += 1;
      offPrefs();
      offProviderSources();
    };
  }, [fetchPrefs, provider]);

  // 唯一的拉取触发点: 初次挂载、断线 -> 重连成功、或 Telegram 绑定身份变化时,
  // 拉取对应 provider 的快照。readyIdentity 为 null(provider 未连接/未绑定)时
  // 不发起无意义的 prefs IPC —— 否则会以 HOOK_NOT_CONNECTED 失败并在 Main 侧
  // 打出误导性的 Slack ERROR(issue #279)。lastReadyIdentityRef 初始为 null,
  // 保证 provider 首次可用即拉取且同一身份不重复触发; 只看布尔 ready 会让 A
  // 换绑 B 时继续展示 A 的偏好。
  useEffect(() => {
    if (readyIdentity !== null && readyIdentity !== lastReadyIdentityRef.current) {
      void fetchPrefs();
    }
    lastReadyIdentityRef.current = readyIdentity;
  }, [readyIdentity, fetchPrefs]);

  // (multi-team)偏好归属 team: 可选清单 = 未 displaced 的绑定; 选中项失效
  // (解绑/被顶)时自动回落首个, 不留悬空选择
  const multiTeam = provider === 'slack' && hook?.serverMultiTeam === true;
  const teams = useMemo(
    () =>
      (provider === 'slack' ? (hook?.bindings ?? []) : [])
        .filter((b) => !b.displaced)
        .map((b) => ({ teamId: b.teamId, teamName: b.teamName })),
    [hook, provider],
  );
  const [selectedTeamRaw, setSelectedTeamRaw] = useState<string | null>(null);
  const selectedTeamId = teams.some((tm) => tm.teamId === selectedTeamRaw)
    ? selectedTeamRaw
    : (teams[0]?.teamId ?? null);
  const activePrefsView: HookPrefsView | ProviderPrefsView | null =
    provider === 'telegram'
      ? prefsView !== null &&
        isProviderPrefsView(prefsView) &&
        prefsView.provider === 'telegram' &&
        prefsView.bindingId === telegramBindingId
        ? prefsView
        : null
      : prefsView !== null && !isProviderPrefsView(prefsView)
        ? prefsView
        : null;

  const prefsFor = useCallback(
    (alias: string): HookWorkspacePrefs => {
      const entries = activePrefsView?.prefs ?? [];
      if (multiTeam && selectedTeamId !== null) {
        // 精确 team 匹配优先; 老 server 存量行(无 teamId)宽松兜底
        return (
          entries.find((e) => e.workspace === alias && (e.teamId ?? null) === selectedTeamId) ??
          entries.find((e) => e.workspace === alias && (e.teamId ?? null) === null) ??
          emptyPrefs(alias)
        );
      }
      return entries.find((e) => e.workspace === alias) ?? emptyPrefs(alias);
    },
    [activePrefsView, multiTeam, selectedTeamId],
  );

  // 目录来源偏好: teamId 精确匹配优先、null 行兜底 —— 与 prefsFor 同语义。
  const providerSourceFor = useCallback(
    (alias: string): string | null => {
      const teamId = multiTeam ? selectedTeamId : null;
      const match = (want: string | null) =>
        providerSources.find(
          (e) => e.channel === provider && e.teamId === want && e.workspace === alias,
        )?.providerId ?? null;
      return match(teamId) ?? (teamId !== null ? match(null) : null);
    },
    [providerSources, provider, multiTeam, selectedTeamId],
  );

  const applyProviderSource = useCallback(
    (alias: string, providerId: string | null) => {
      const teamId = multiTeam ? selectedTeamId : null;
      const revision = ++providerSourceRevisionRef.current;
      void window.electronAPI.hookControl
        .setWorkspaceProviderSource({ channel: provider, teamId, workspace: alias, providerId })
        .then((res) => {
          if (revision === providerSourceRevisionRef.current) setProviderSources(res.entries);
        })
        .catch((err: unknown) => {
          if (revision !== providerSourceRevisionRef.current) return;
          toast.error(
            extractIpcError(err)?.message ?? t('settings.tina.prefs.toast.saveFailed'),
          );
        });
    },
    [provider, multiTeam, selectedTeamId, t],
  );

  const applyPatch = useCallback(
    // alsoProviderSource(可选): 远端 model/effort 写**成功后**再落本地来源 ——
    // 两个持久面串联而非并行(Greptile/codex review: 并行 fire-and-forget 会在
    // 一半失败时留下「新来源配旧模型」的分裂态)。顺序选「先远端后本地」:远端
    // 失败 → 整体失败, 来源不动, 状态与操作前一致;本地失败(概率远小)→ 旧来源
    // 配新模型, 派发端 effectiveSourceIdForModel 收窄兜底, 行为等于改前语义。
    (workspace: string, patch: HookPrefsPatch, alsoProviderSource?: string | null) => {
      // A server push, binding change, retry, or newer mutation must win over
      // this response. Otherwise a delayed set reply can roll the UI back to
      // an older provider snapshot and clear another mutation's pending state.
      const revision = ++fetchRevisionRef.current;
      const mutationRevision = ++mutationRevisionRef.current;
      setPendingWs(workspace);
      const request =
        provider === 'telegram'
          ? window.electronAPI.hookControl.setProviderWorkspacePrefs(workspace, patch)
          : window.electronAPI.hookControl.setWorkspacePrefs(
              workspace,
              patch,
              multiTeam ? selectedTeamId : undefined,
            );
      void request
        .then((res) => {
          // 来源落地在快照守卫**之前**(codex review): invoke 成功 = 远端已确认
          // 本次 (model, effort) 写入 —— 这一事实不因「更新的快照先到」而失效;
          // 守卫只管下方 UI 快照是否回填,若来源也被守卫跳过(prefs 回执经广播
          // 先到的正常时序), 会留下「新模型 + 旧来源」的持久分裂。
          if (alsoProviderSource !== undefined) {
            applyProviderSource(workspace, alsoProviderSource);
          }
          if (revision !== fetchRevisionRef.current) return;
          const nextPrefs: HookPrefsView | ProviderPrefsView = res.prefs;
          if (
            provider === 'telegram' &&
            (!isProviderPrefsView(nextPrefs) ||
              nextPrefs.provider !== 'telegram' ||
              nextPrefs.bindingId !== telegramBindingIdRef.current)
          ) {
            return;
          }
          if (provider === 'slack' && isProviderPrefsView(nextPrefs)) return;
          fetchRevisionRef.current += 1;
          setPrefsView(nextPrefs);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (revision !== fetchRevisionRef.current) return;
          const ipcErr = extractIpcError(err);
          if (ipcErr?.code === 'HOOK_PREFS_TIMEOUT') setLoadError('unavailable');
          toast.error(ipcErr?.message ?? t('settings.tina.prefs.toast.saveFailed'));
          void fetchPrefs();
        })
        .finally(() => {
          if (mutationRevision === mutationRevisionRef.current) setPendingWs(null);
        });
    },
    [fetchPrefs, t, multiTeam, provider, selectedTeamId, applyProviderSource],
  );

  const bound = providerBindingConfirmed && activePrefsView?.bound === true;
  const providerLabel = t(
    provider === 'telegram'
      ? 'settings.tina.prefs.providerTelegram'
      : 'settings.tina.prefs.providerSlack',
  );
  const hint = !connected
    ? t('settings.tina.prefs.requireConnected', { provider: providerLabel })
    : loadError === 'unavailable'
      ? t('settings.tina.prefs.serverUnsupported')
      : !providerBindingConfirmed || (activePrefsView !== null && !bound)
        ? t('settings.tina.prefs.requireBinding', { provider: providerLabel })
        : null;

  return {
    prefsFor,
    providerSourceFor,
    applyProviderSource,
    editable: connected && bound && loadError === null,
    pendingWs,
    hint,
    retry: loadError === 'unavailable' ? () => void fetchPrefs() : null,
    imDefaults,
    applyPatch,
    teams,
    selectedTeamId,
    selectTeam: setSelectedTeamRaw,
    showTeamChip: multiTeam && teams.length > 1,
  };
}

/** 字段外框:标题 + 控件,三个字段共用,保证 label 排版一致。 */
function PrefsField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-11 text-[var(--text-tertiary)]">{label}</span>
      {children}
    </div>
  );
}

/** hook prefs 的 agentKind('claude-code' | 'codex')→ 选择器的 vendor key。 */
function toVendorKey(agentKind: string | null): 'cc' | 'codex' {
  return agentKind === 'codex' ? 'codex' : 'cc';
}

/**
 * 选择器的 vendor key → hook prefs 的 agentKind。
 * MakerVendor 还含 'orca' 等本编辑器不支持的值 —— 分段只有 Claude/Codex 两项,该分支
 * 物理不可达;若未来有人把别的 vendor 接进来,fail-fast 好过静默写成 claude-code
 * 偏好(Copilot review)。
 */
function toAgentKind(vendor: MakerVendor): KnownAgent {
  if (vendor === 'codex') return 'codex';
  if (vendor === 'cc') return 'claude-code';
  throw new Error(`WorkspacePrefsEditor: unsupported vendor '${vendor}' for hook prefs`);
}


/** 目录卡片内的偏好编辑行(agent / 模型 / 权限三字段)。alias 为该行当前生效别名。 */
export function WorkspacePrefsEditor({
  alias,
  state,
}: {
  alias: string;
  state: HookWorkspacePrefsState;
}) {
  const { t } = useTranslation();
  const claudeCaps = useAgentCapabilities('claude-code');
  const codexCaps = useAgentCapabilities('codex');
  const capsByAgent = useMemo(
    () =>
      ({
        'claude-code': claudeCaps.capabilities,
        codex: codexCaps.capabilities,
      }) as Record<KnownAgent, AgentCapabilities | null>,
    [claudeCaps.capabilities, codexCaps.capabilities],
  );
  const capsOf = useCallback(
    (agentKind: string): AgentCapabilities | null =>
      AGENT_KINDS.includes(agentKind as KnownAgent) ? capsByAgent[agentKind as KnownAgent] : null,
    [capsByAgent],
  );

  const prefs = state.prefsFor(alias);
  const eff = resolveEffectiveRow(prefs, state.imDefaults, (k) => toPrefsCaps(capsOf(k)));
  const effAgentCaps = capsOf(eff.agentKind.id ?? '');
  const disabled = !state.editable || state.pendingWs === alias;
  const vendorKey = toVendorKey(eff.agentKind.id);

  /** 落一个模型选择(分段行与 flat 行共用): 随手写入 (agent, model) 配对并校准 effort。 */
  const applyModel = (next: string) => {
    if (next === prefs.model || eff.agentKind.id === null) return;
    state.applyPatch(
      alias,
      patchForModelChange(eff.agentKind.id, next, prefs, toPrefsCaps(effAgentCaps)),
    );
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      {/* agent 分段是固定 168px 的 pill,不参与压缩 —— 卡片变窄时整块换行,
          而不是把 Claude / Codex 两段挤到溢出容器。
          禁用只看行级只读态,**不含 effAgentCaps === null**:patchForAgentChange 只清
          model/effort、不做能力校准,切 agent 本身不需要当前 agent 的清单;若跟着
          caps 一起禁,当前 agent 能力请求瞬时失败就把整行钉死,用户连切到另一个
          (可用的)agent 都不行(codex review)。模型/权限字段仍按 caps 禁用 ——
          它们的选项列表真的来自 caps。 */}
      <PrefsField label={t('settings.tina.prefs.agentLabel')} className="shrink-0">
        <VendorSegmentedSwitcher
          value={vendorKey}
          width={168}
          // 可及名 = 本地化字段名 + 行别名:每行目录都有一个同样的分段,不带别名时
          // 读屏听到的全部是同一个名字,行与行无法分辨(codex review)。
          ariaLabel={`${t('settings.tina.prefs.agentLabel')} · ${alias}`}
          disabled={disabled}
          // 当前段可能是**继承值**(prefs.agentKind 为 null / 过期未知值时显示解析出的
          // 默认 agent),重选它 = 钉成显式偏好 —— 与模型字段的 reselectEmitsChange 同语义;
          // 显式同值由下方 nextAgent === prefs.agentKind 去重,不产生空写。
          reselectEmitsChange
          onChange={(next) => {
            const nextAgent = toAgentKind(next);
            if (nextAgent === prefs.agentKind) return;
            state.applyPatch(alias, patchForAgentChange(nextAgent));
          }}
        />
      </PrefsField>
      {/* 模型 + 思考强度同一个控件, **composer 同款全功能标准面板**(2026-07 用户
          定稿基准: 全软件一个模型选择面板, 处处同行为, 差异只有样式):供应商分段、
          订阅来源、推理强度全开。来源(providerId)是纯客户端维度, 落本地
          workspaceProviderSourceStore; model/effort 照旧走 server prefs 通道
          (Slack /model 卡展示不受影响)。派发侧按 (来源, 模型) 经
          effectiveSourceIdForModel 收窄, 来源断开/不提供该模型时自动回落,
          不会拼出不可能路由 —— 「选 A 落 B」的根因(选了来源没地方存)已消除。 */}
      <PrefsField label={t('settings.tina.prefs.modelLabel')} className="flex-1 basis-[220px]">
        <ModelSelector
          modelId={eff.model.id ?? ''}
          effort={eff.effort.id ?? ''}
          vendorKey={vendorKey}
          triggerVariant="field"
          popoverSide="bottom"
          dense
          // 可及名上下文与 agent 分段同规则(字段名 · 行别名),多卡片同屏读屏可区分。
          ariaContext={`${t('settings.tina.prefs.modelLabel')} · ${alias}`}
          // 能力清单未就绪才禁用; agent 未显式设置时也可直接选模型(随手把
          // agent 显式配对写入, 与 Slack 卡「选中模型即落 (agent, model)」同规则)
          disabled={disabled || effAgentCaps === null || eff.agentKind.id === null}
          // 这一行的 modelId 可能是**解析出来的继承值**(prefs.model 为 null 时来自 IM
          // 新会话默认), 点它的语义是「把继承值钉成本目录的显式偏好」, 必须照常回调 ——
          // 否则用户点了没反应, 之后上游默认一变这条偏好就被静默改掉。
          reselectEmitsChange
          // 已存模型不在可见清单(被隐藏 / 供应商断开 / 目录下架)时显示裸 id 而非
          // 「选择模型」占位符: 占位符会把「存过但当前不可用」显示成「没选过」, 用户
          // 既看不到自己存的是什么、也无从判断为何 bot 用的不是它。与本组件接管前
          // (PrefsSelect 的 modelLabel 回落裸 id)行为一致; 派发侧另有回落并记日志。
          unknownModelLabel={(id) => id}
          // 非选中行 hover 配置(推理强度/Fast)与 composer 共用同一份模型级全局预设。
          modelMemory={{
            getEffort: getProviderModelEffort,
            setEffort: setProviderModelEffort,
            setChoice: setProviderModelChoice,
            getFast: getProviderModelFast,
            setFast: setProviderModelFast,
          }}
          currentProviderId={state.providerSourceFor(alias)}
          // 分段行原子选择:model/effort 走远端 prefs, 成功后来源落本地(串联,
          // 见 applyPatch 的 alsoProviderSource 注释)。effort 取该 (来源, 模型) 的
          // 全局预设记忆(用户 hover 非选中行改过的档位, codex review;ModelSelector
          // 的 onProviderChange 只回传 provider+model 两参, 记忆值需自取), 该模型
          // 支持时进 patch, 否则维持 patchForModelChange 的模型默认校准。
          onProviderChange={(providerId, modelId) => {
            if (eff.agentKind.id === null) return;
            const caps = toPrefsCaps(effAgentCaps);
            if (modelId) {
              const patch = patchForModelChange(eff.agentKind.id, modelId, prefs, caps);
              const remembered =
                providerId && isKnownAgent(eff.agentKind.id)
                  ? getProviderModelEffort(eff.agentKind.id, providerId, modelId)
                  : undefined;
              if (
                remembered &&
                caps?.models.find((m) => m.id === modelId)?.efforts.includes(remembered)
              ) {
                patch.effort = remembered;
              }
              state.applyPatch(alias, patch, providerId);
            } else {
              state.applyProviderSource(alias, providerId);
            }
          }}
          onModelChange={applyModel}
          onEffortChange={(next) => {
            if (next !== prefs.effort) state.applyPatch(alias, { effort: next });
          }}
        />
      </PrefsField>
      <PrefsField label={t('settings.tina.prefs.permissionLabel')} className="basis-[160px]">
        <PermissionSelector
          permissionMode={eff.permissionMode.id ?? HOOK_DEFAULT_PERMISSION_MODE}
          vendorKey={vendorKey}
          triggerVariant="field"
          dense
          // 可及名上下文与 agent 分段同规则(字段名 · 行别名),多卡片同屏读屏可区分。
          ariaContext={`${t('settings.tina.prefs.permissionLabel')} · ${alias}`}
          disabled={disabled || effAgentCaps === null}
          onPermissionModeChange={(next) => {
            if (next !== prefs.permissionMode) state.applyPatch(alias, { permissionMode: next });
          }}
        />
      </PrefsField>
    </div>
  );
}
