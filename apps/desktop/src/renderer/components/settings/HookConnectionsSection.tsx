/**
 * HookConnectionsSection —— 「IM 机器人」页「官方」栏(Cindy 渠道)。
 * i18n key 刻意留在 settings.remoteControl.hook.* 命名空间(50+ 条 × 4 语言的
 * 纯搬家徒增 diff 与漏改风险)。
 * ---------------------------------------------------------------------------
 * 中心 slack-hook-server 的接入面(内置连接, 零凭证配置)。结构与「个人」栏
 * 对齐: 每个渠道一张 ImChannelSettingsCard 手风琴卡, 同刻最多展开一张 ——
 *
 *   - Slack 卡: 收起行 = 状态徽章 + 绑定摘要 + 总开关。开关即绑定: 开 = 连接,
 *     main 自动发起 Sign in with Slack(OIDC)弹系统浏览器; 关 = 解除绑定并
 *     断开(再开需重新授权)。展开区承载授权进度与「复制链接」兜底(远程控制
 *     时浏览器落被控机, 复制到本机完成授权, 规则 26)、未安装 App 引导、
 *     失败原因, 以及 multi-team 的 workspace 绑定列表(每绑定一行: team +
 *     用户 + 解绑; displaced 行给「重新绑定」; 「添加」入口仅 server 宣告
 *     multi-team 时显示);
 *   - toggle 视觉开态 = 绑定 confirmed(不是 enabled 意图): 连接中 / 授权中 /
 *     待安装等在途态一律显示为关, 进度由徽章与摘要承载 —— 开着但没绑定的
 *     样子会被误读为"已可用"。在途态再点 toggle = 取消本轮流程(关回)。
 *     打开渠道开关时自动展开对应卡, 让授权进度与兜底动作立即可见;
 *   - workspace 未装 App(failed + not-installed): 弹确认框问要不要安装,
 *     确认开安装授权页、等 server 装完自动补完绑定(免二次授权), 取消关回
 *     开关; 等待期显示引导行(安装/复制链接 + 等待提示);
 *   - Telegram 卡: 同构 —— 开关 + 状态徽章 + 关联动作(打开 bot / 加群 /
 *     解绑);
 *   - X 卡: 与 Telegram 卡同构(provider-neutral 状态机), 绑定走 X OAuth2
 *     授权页(open connect url / 复制链接), 无加群概念(动作按 binding.actions
 *     数据驱动, X 的 actions 里没有 add_to_group 自然不渲染);
 *   - 工作目录映射内嵌在每张渠道卡的展开区: 目录清单**设备共享**(所有渠道
 *     同一份, 刻意设计, 任一卡里增删都作用于全部渠道), 运行偏好按渠道隔离,
 *     由所在卡决定读写哪个渠道的那份(Slack 多绑定时再叠 workspace 归属
 *     chip); 系统目录选择器添加, 别名可改, 变更即保存;
 *   - 状态经 onStatusChanged 推送实时刷新; 数据先取后渲染, 无 loading 态,
 *     状态迁移不增删提示行避免布局跳动(规则 7)。
 *
 * 颜色全部走主题 token; 状态徽章沿用「个人」栏的 --settings-badge-* 语义色。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  HOOK_BIND_REASON_ALREADY_BOUND,
  HOOK_BIND_REASON_NOT_INSTALLED,
  HOOK_CHAT_WORKSPACE_ALIAS,
  HOOK_WORKSPACE_ALIAS_RE,
  slackHookInstallUrl,
  type HookTeamBindingView,
  type ProviderHookView,
  type SlackHookView,
} from '../../../shared/hookControlIpc';

/** provider-neutral 渠道卡覆盖的 provider(Slack 走 legacy 专属卡)。 */
type NeutralCardProvider = 'telegram' | 'x';
import { useHookWorkspacePrefs, WorkspacePrefsEditor } from './HookWorkspacePrefsEditor';
import { ImChannelSettingsCard } from './ImChannelSettingsCard';

/** 「官方」栏的渠道手风琴卡(同刻最多展开一张, 交互对齐「个人」栏)。 */
type CindyImCard = 'slack' | 'telegram' | 'x';

/** 渠道卡状态徽章的色调档(映射到「个人」栏同款 --settings-badge-* token)。 */
type ChannelBadgeTone = 'ok' | 'progress' | 'attention' | 'error';

function badgeToneColor(tone: ChannelBadgeTone): string {
  switch (tone) {
    case 'ok':
      return 'var(--settings-badge-connected)';
    case 'progress':
      return 'var(--settings-badge-saved)';
    case 'error':
      return 'var(--settings-badge-error)';
    default:
      return 'var(--settings-badge-needs-config)';
  }
}

/** 传输状态 → 徽章色调(Slack 与 Telegram 的 status 同一枚举语义)。 */
function transportBadgeTone(status: SlackHookView['status']): ChannelBadgeTone {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'connecting':
    case 'standby':
      return 'progress';
    case 'error':
      return 'error';
    default:
      return 'attention';
  }
}

/** 收起行状态徽章(结构与 FeishuBotSection 的状态 pill 逐字对齐)。 */
function ChannelStatusBadge({ tone, label }: { tone: ChannelBadgeTone; label: string }) {
  const color = badgeToneColor(tone);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2.5 py-1 text-11 font-medium"
      style={{
        letterSpacing: '0.12px',
        color: tone === 'ok' ? 'var(--settings-badge-connected-text)' : color,
      }}
      role="status"
      aria-live="polite"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

/** 小号胶囊按钮(「复制链接 / 安装 Slack App」共用)。 */
const pillBtn =
  'flex h-6 shrink-0 items-center rounded-full border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50';

const RESERVED_WORKSPACE_ALIASES = new Set([
  HOOK_CHAT_WORKSPACE_ALIAS,
  '__proto__',
  'prototype',
  'constructor',
]);

/** 目录名 -> 合法别名: 只留 [A-Za-z0-9_-], 其余折叠成 '-', 撞名或保留名加序号。 */
export function deriveAlias(dir: string, taken: ReadonlySet<string>): string {
  const base = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'ws';
  let alias =
    base
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'ws';
  if (taken.has(alias) || RESERVED_WORKSPACE_ALIASES.has(alias)) {
    for (let i = 2; ; i++) {
      const candidate = `${alias.slice(0, 32 - String(i).length - 1)}-${i}`;
      if (!taken.has(candidate) && !RESERVED_WORKSPACE_ALIASES.has(candidate)) {
        alias = candidate;
        break;
      }
    }
  }
  return alias;
}

/** Validate a complete renderer edit before constructing its IPC payload. */
export function workspaceRowsToMap(
  rows: ReadonlyArray<{ alias: string; dir: string }>,
): Record<string, string> | null {
  const workspaces: Record<string, string> = {};
  for (const row of rows) {
    const alias = row.alias.trim();
    const dir = row.dir.trim();
    if (
      !alias ||
      !dir ||
      !HOOK_WORKSPACE_ALIAS_RE.test(alias) ||
      RESERVED_WORKSPACE_ALIASES.has(alias) ||
      Object.hasOwn(workspaces, alias)
    ) {
      return null;
    }
    workspaces[alias] = dir;
  }
  return workspaces;
}

export function HookConnectionsSection() {
  const { t } = useTranslation();
  const [hook, setHook] = useState<SlackHookView | null>(null);
  /** 工作目录行的本地编辑态(别名输入中不被状态推送打断, blur 时提交)。 */
  const [rows, setRows] = useState<Array<{ alias: string; dir: string }>>([]);
  /** 最近一次与 main 对齐的 workspaces 序列化(判断外部变更用)。 */
  const syncedRef = useRef<string>('');
  /**
   * 渠道卡同刻最多展开一张(交互对齐「个人」栏 PersonalGroupContent), 默认
   * 全收起 —— 收起行自带状态徽章与绑定摘要。打开渠道开关时自动展开对应卡,
   * 让授权进度与兜底动作(复制链接 / 安装引导)立即可见。
   */
  const [expandedCard, setExpandedCard] = useState<CindyImCard | null>(null);
  const toggleCard = (card: CindyImCard) =>
    setExpandedCard((current) => (current === card ? null : card));
  /** Older IPC replies and server pushes must never overwrite a newer view transition. */
  const viewRevisionRef = useRef(0);
  /**
   * Confirmation dialogs outlive the render that opened them. Keep the latest
   * authoritative snapshot so a delayed confirmation cannot mutate a binding
   * that has since been replaced.
   */
  const hookRef = useRef<SlackHookView | null>(hook);
  hookRef.current = hook;

  const applyView = useCallback((view: SlackHookView) => {
    setHook(view);
    const serialized = JSON.stringify(view.workspaces);
    if (serialized !== syncedRef.current) {
      syncedRef.current = serialized;
      setRows(Object.entries(view.workspaces).map(([alias, dir]) => ({ alias, dir })));
    }
  }, []);
  const applyPushedView = useCallback(
    (view: SlackHookView) => {
      viewRevisionRef.current += 1;
      applyView(view);
    },
    [applyView],
  );

  useEffect(() => {
    const requestedAtRevision = ++viewRevisionRef.current;
    void window.electronAPI.hookControl
      .get()
      .then((res) => {
        if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.hookControl.onStatusChanged(applyPushedView);
    return () => {
      viewRevisionRef.current += 1;
      unsubscribe();
    };
  }, [applyPushedView, applyView]);

  const saveWorkspaces = useCallback(
    async (next: Array<{ alias: string; dir: string }>) => {
      // Reject the whole edit before assigning attacker-shaped keys to a
      // plain object. Silently skipping/overwriting one row could persist a
      // partial map and remove a previously valid workspace.
      const workspaces = workspaceRowsToMap(next);
      if (workspaces === null) {
        toast.error(t('settings.remoteControl.hook.toast.saveFailed'));
        return;
      }
      // 无变更的 blur(点进输入框又点出去)不发保存 —— 避免无谓 IPC 与状态刷新
      if (JSON.stringify(workspaces) === syncedRef.current) return;
      try {
        const requestedAtRevision = ++viewRevisionRef.current;
        const res = await window.electronAPI.hookControl.setWorkspaces(workspaces);
        if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
      } catch (err) {
        toast.error(
          extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.saveFailed'),
        );
      }
    },
    [applyView, t],
  );

  /**
   * 开关即绑定(即时生效): 开 = 连接, main 连上后自动拉起浏览器 Slack 授权;
   * 关 = 解除绑定并断开(main 发 bind.revoke), 再开需重新授权。
   */
  const handleToggle = useCallback(
    (enabled: boolean) => {
      if (enabled) setExpandedCard('slack');
      const requestedAtRevision = ++viewRevisionRef.current;
      void window.electronAPI.hookControl
        .setEnabled(enabled)
        .then((res) => {
          if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
        })
        .catch(() => toast.error(t('settings.remoteControl.hook.toast.toggleFailed')));
    },
    [applyView, t],
  );

  // ── (multi-team)派生视图 ────────────────────────────────────────────────
  // multiUi: 走多 workspace 列表 UI。serverMultiTeam 是权威信号; bindings 非空
  // 兜冷启动(serverFeatures 要 welcome 后才有, 缓存行先撑起列表, 避免连上一
  // 瞬间 UI 从单绑定样式跳成列表样式, 规则 7)。老 server 会在 welcome 时清掉
  // 缓存行, multiUi 自然回落。
  const multiUi = hook !== null && (hook.serverMultiTeam || hook.bindings.length > 0);
  const activeTeams = hook?.bindings.filter((b) => !b.displaced) ?? [];
  const displacedCount = (hook?.bindings.length ?? 0) - activeTeams.length;
  /** 状态行「(M 个待处理)」= 在途/终止态授权 + displaced 行。 */
  const pendingIssueCount = (hook !== null && hook.pendingBind !== null ? 1 : 0) + displacedCount;

  /** (multi-team)绑定动作 IPC 的统一收口(应用快照 + 失败 toast)。 */
  const runHookAction = useCallback(
    (
      action: () => Promise<{ hook: SlackHookView }>,
      options?: { localizedErrorOnly?: boolean },
    ) => {
      const requestedAtRevision = ++viewRevisionRef.current;
      void action()
        .then((res) => {
          if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
        })
        .catch((err: unknown) => {
          const localizedFallback = t('settings.remoteControl.hook.toast.actionFailed');
          toast.error(
            options?.localizedErrorOnly
              ? localizedFallback
              : (extractIpcError(err)?.message ?? localizedFallback),
          );
        });
    },
    [applyView, t],
  );

  /**
   * X 的默认工作目录写入。
   *
   * 只有 X 有这个控件: Slack / Telegram 能在会话里当场挑目录, X 一次交互只允许
   * 回一条公开推文, 没有承载选择面板的位置 —— 不预设的话所有任务都只能落在
   * 「对话」上, 碰不到本地仓库。
   */
  const setXDefaultWorkspace = useCallback(
    async (alias: string | null) => {
      try {
        const requestedAtRevision = ++viewRevisionRef.current;
        const res = await window.electronAPI.hookControl.setXDefaultWorkspace(alias);
        if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
      } catch (err) {
        toast.error(
          extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.saveFailed'),
        );
      }
    },
    [applyView, t],
  );

  const handleLifecycleAnnouncementToggle = useCallback(
    (enabled: boolean) => {
      runHookAction(
        () => window.electronAPI.hookControl.setLifecycleAnnouncement(enabled),
        { localizedErrorOnly: true },
      );
    },
    [runHookAction],
  );

  // "等安装"确认框: binding 转入 failed + not-installed(且开关开着)时弹一次 ——
  // 确认则打开安装授权页(装完 server 自动补完绑定、推 confirmed, 免二次授权);
  // 取消则关回开关(无事发生; main 的关分支会发 bind.revoke, 作废 server 侧
  // 等安装登记, 之后即使有人装了 App 也不会偷偷绑上)。multi-team 下取消只作废
  // 这次"添加 workspace"尝试(cancelPendingBind), 不动总开关与既有绑定。
  // ref 记录已弹, 只在 false→true 转变沿弹一次, 状态广播的重渲染不重复弹。
  const { confirm } = useConfirmDialog();
  const installPromptShownRef = useRef(false);
  const awaitingInstall =
    hook !== null &&
    hook.enabled &&
    hook.binding?.state === 'failed' &&
    hook.binding?.reason === HOOK_BIND_REASON_NOT_INSTALLED;
  /**
   * 确认框是异步的, 弹着期间状态可能已翻页(典型: 用户已在浏览器里装完 App,
   * server 推回 confirmed): 确认/取消回调只能对"仍在等安装"的现状生效 ——
   * 陈旧弹窗上点「取消」不得误杀刚建立的绑定, 点「安装」也不再重复开安装页。
   * 用 ref 存最新值, 避免回调闭包捕获弹窗时刻的旧快照。
   */
  const awaitingInstallRef = useRef(false);
  awaitingInstallRef.current = awaitingInstall;
  // 安装链接: 优先 server 按 workspace 定制的(带 team 参数, 安装页预选到刚
  // 授权的工作区), 老 server 不下发时回退通用 /slack/install
  const installUrl =
    hook?.binding?.installUrl ?? (hook !== null ? slackHookInstallUrl(hook.url) : null);
  /**
   * The confirmation can remain open while a push changes the binding mode or
   * custom install URL. Read those values at decision time instead of acting
   * on the render that originally opened the dialog.
   */
  const installTargetKey = JSON.stringify({
    multiUi,
    pendingTeamId: hook?.pendingBind?.teamId ?? null,
    slackUserId: hook?.binding?.slackUserId ?? null,
  });
  const installDecisionRef = useRef({ installUrl, multiUi, targetKey: installTargetKey });
  installDecisionRef.current = { installUrl, multiUi, targetKey: installTargetKey };
  /** Invalidates a dialog when its failed bind attempt ends, even if a later attempt targets the same team. */
  const installPromptGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!awaitingInstall) {
      installPromptGenerationRef.current += 1;
      installPromptShownRef.current = false;
      return;
    }
    if (installPromptShownRef.current) return;
    installPromptShownRef.current = true;
    void (async () => {
      const promptGeneration = ++installPromptGenerationRef.current;
      const targetKey = installDecisionRef.current.targetKey;
      const ok = await confirm({
        title: t('settings.remoteControl.hook.notInstalled.confirmTitle'),
        description: t('settings.remoteControl.hook.notInstalled.confirmDescription'),
        confirmText: t('settings.remoteControl.hook.notInstalled.confirmInstall'),
        cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
      });
      // 弹窗期间状态已翻页(装完自动 confirmed / 超时弹回)则本次选择作废:
      // 取消不关刚绑好的开关, 确认不重复开安装页
      if (
        !mountedRef.current ||
        !awaitingInstallRef.current ||
        installPromptGenerationRef.current !== promptGeneration
      ) {
        return;
      }
      const decision = installDecisionRef.current;
      // A single attempt may receive a more specific install URL after the
      // dialog opens, so consume the latest URL. A different target identity,
      // however, belongs to another authorization attempt and must not inherit
      // this stale confirmation.
      if (decision.targetKey !== targetKey) return;
      if (ok) {
        if (decision.installUrl) void window.electronAPI.openExternal(decision.installUrl);
      } else if (decision.multiUi) {
        // multi-team: 取消只作废这次"添加 workspace"尝试, 既有绑定不受影响
        runHookAction(() => window.electronAPI.hookControl.cancelPendingBind());
      } else {
        handleToggle(false);
      }
    })();
  }, [awaitingInstall, confirm, handleToggle, runHookAction, t]);

  const handleAddWorkspace = async () => {
    const res = await window.electronAPI.showOpenDirectoryDialog();
    if (res.canceled || !res.path) return;
    const dir = res.path as string;
    if (rows.some((r) => r.dir === dir)) return;
    const next = [
      ...rows,
      {
        alias: deriveAlias(dir, new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...rows.map((r) => r.alias)])),
        dir,
      },
    ];
    setRows(next);
    await saveWorkspaces(next);
  };

  const handleRemoveWorkspace = async (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    await saveWorkspaces(next);
  };

  /** 更换某行的目录(保留别名 —— 偏好按别名归属, 换目录不丢偏好)。 */
  const handleChangeDir = async (index: number) => {
    const res = await window.electronAPI.showOpenDirectoryDialog();
    if (res.canceled || !res.path) return;
    const dir = res.path as string;
    if (rows.some((r, i) => i !== index && r.dir === dir)) return;
    const next = rows.slice();
    next[index] = { ...next[index], dir };
    setRows(next);
    await saveWorkspaces(next);
  };

  // 目录清单设备共享；运行偏好按 provider 隔离。三个 hook 都始终调用，避免
  // provider 开关切换时改变 React hook 顺序。
  const slackPrefsState = useHookWorkspacePrefs(hook, 'slack');
  const telegramPrefsState = useHookWorkspacePrefs(hook, 'telegram');
  const xPrefsState = useHookWorkspacePrefs(hook, 'x');

  /** 复制授权链接(远程控制兜底: 到本机浏览器打开, 规则 26)。 */
  const handleCopyLink = async () => {
    const url = hook?.binding?.authorizeUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      /* 剪贴板不可用时静默(极少见); 本机场景浏览器已自动弹出, 不阻断 */
    }
  };

  /** 复制 App 安装链接(未安装引导行的远程控制兜底, 规则 26)。 */
  const handleCopyInstallLink = async () => {
    if (installUrl === null) return;
    try {
      await navigator.clipboard.writeText(installUrl);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      /* 剪贴板不可用时静默; 本机场景「安装 Slack App」按钮即可直达 */
    }
  };

  const handleProviderToggle = (provider: NeutralCardProvider, enabled: boolean) => {
    if (enabled) setExpandedCard(provider);
    runHookAction(() => window.electronAPI.hookControl.setProviderEnabled(provider, enabled));
  };

  const handleProviderOpen = (
    provider: NeutralCardProvider,
    action: 'connect' | 'provider' | 'add-to-group',
  ) => {
    void window.electronAPI.hookControl.openProviderAction(provider, action).catch((err: unknown) => {
      toast.error(
        extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.actionFailed'),
      );
    });
  };

  const handleCopyProviderLink = async (provider: NeutralCardProvider) => {
    const url = hook?.[provider].binding?.connectUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      toast.error(t('settings.remoteControl.hook.toast.actionFailed'));
    }
  };

  const handleProviderUnlink = async (provider: NeutralCardProvider) => {
    const targetBindingId =
      hook?.[provider].binding?.state === 'confirmed' ? hook[provider].binding.bindingId : null;
    if (targetBindingId === null) return;
    const ok = await confirm({
      title: t(`settings.remoteControl.hook.${provider}.unlinkConfirmTitle`),
      description: t(`settings.remoteControl.hook.${provider}.unlinkConfirmDescription`),
      confirmText: t(`settings.remoteControl.hook.${provider}.unlink`),
      cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
    });
    const currentBinding = hookRef.current?.[provider].binding;
    if (
      !ok ||
      !mountedRef.current ||
      currentBinding?.state !== 'confirmed' ||
      currentBinding.bindingId !== targetBindingId
    ) {
      return;
    }
    runHookAction(() => window.electronAPI.hookControl.providerBindRevoke(provider));
  };

  /**
   * (multi-team)解绑某 workspace: 走确认弹窗(危险操作文案)。displaced 行的
   * "删除"同一入口 —— main 侧按行状态区分(活跃行发 bind.revoke, displaced 行
   * 仅清本地缓存), 文案按行状态取。
   */
  const handleRemoveBinding = async (b: HookTeamBindingView) => {
    const target = {
      teamId: b.teamId,
      slackUserId: b.slackUserId,
      displaced: b.displaced,
    };
    const teamLabel = b.teamName ?? b.teamId;
    const ok = await confirm({
      title: t('settings.remoteControl.hook.multi.removeConfirmTitle', { team: teamLabel }),
      description: b.displaced
        ? t('settings.remoteControl.hook.multi.removeDisplacedConfirmDescription')
        : t('settings.remoteControl.hook.multi.removeConfirmDescription', { team: teamLabel }),
      confirmText: t('settings.remoteControl.hook.multi.removeConfirm'),
      cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
    });
    const stillSameBinding = hookRef.current?.bindings.some(
      (current) =>
        current.teamId === target.teamId &&
        current.slackUserId === target.slackUserId &&
        current.displaced === target.displaced,
    );
    if (!ok || !mountedRef.current || !stillSameBinding) return;
    runHookAction(() => window.electronAPI.hookControl.revokeTeam(target.teamId));
  };

  // 数据未就绪不渲染任何内容(规则 7: 无 loading 态、不闪空状态)
  if (hook === null) return null;

  const bindingState = hook.binding?.state ?? 'none';
  /**
   * toggle 视觉开态:
   *   - 单绑定(老 server): 绑定已确认(连接 + 绑定齐备才算"开") —— enabled 只是
   *     持久化的意图, 连接中 / 授权中 / 待安装期间开关显示为关;
   *   - multi-team: 有可用绑定即算"开"(不再要求单一 confirmed); 首次 0 绑定
   *     授权中仍显示关+「授权中…」, 与现状一致。
   * 两种模式都用绑定快照而非连接态承载开态 —— 断线重连的瞬时抖动不弹开关
   * (连接状态由左侧状态点与状态行表达, 规则 7 不跳变)。
   */
  const toggleChecked = multiUi
    ? hook.enabled && activeTeams.length > 0
    : hook.enabled && hook.binding?.state === 'confirmed';
  /** 在途态(意图已开但尚无可用绑定): 此时再点 toggle = 取消本轮流程(关回)。 */
  const toggleInProgress = hook.enabled && !toggleChecked;
  /** 授权检出 workspace 未安装 App: 走专属安装引导行(结构化 reason, 规则 9)。
   *  multi-team 下 hook.binding 是 pendingBind 的 legacy 映射, 判据通用。 */
  const isNotInstalled =
    bindingState === 'failed' && hook.binding?.reason === HOOK_BIND_REASON_NOT_INSTALLED;
  /** 失败/被顶态: 用一行错误说明呈现(而非并进顶部状态行)。 */
  const isBindingFailure =
    bindingState === 'denied' ||
    bindingState === 'expired' ||
    bindingState === 'failed' ||
    bindingState === 'revoked';
  // 顶部状态行合并的绑定态(仅连上时有意义; 失败态走下方错误行, 不并进这里;
  // "等安装"是保持在线的中间态, 单独给「待安装 App」)。multi-team 分支:
  // 单个绑定沿用「已绑定 {team} @{user}」; 多个绑定/有待处理项给数量摘要。
  const bindingLabel =
    hook.status !== 'connected'
      ? null
      : multiUi
        ? activeTeams.length === 1 && pendingIssueCount === 0
          ? t('settings.remoteControl.hook.statusBoundTeam', {
              name: activeTeams[0].slackUserName ?? activeTeams[0].slackUserId,
              team: activeTeams[0].teamName ?? activeTeams[0].teamId,
            })
          : activeTeams.length > 0
            ? `${t('settings.remoteControl.hook.multi.statusWorkspaces', { count: activeTeams.length })}${
                pendingIssueCount > 0
                  ? t('settings.remoteControl.hook.multi.statusPendingSuffix', {
                      count: pendingIssueCount,
                    })
                  : ''
              }`
            : hook.pendingBind?.state === 'pending'
              ? t('settings.remoteControl.hook.authorizing')
              : isNotInstalled
                ? t('settings.remoteControl.hook.notInstalled.status')
                : t('settings.remoteControl.hook.statusUnbound')
        : bindingState === 'confirmed'
          ? hook.binding?.teamName
            ? t('settings.remoteControl.hook.statusBoundTeam', {
                name: hook.binding?.slackUserName ?? hook.binding?.slackUserId ?? '',
                team: hook.binding.teamName,
              })
            : t('settings.remoteControl.hook.statusBound', {
                name: hook.binding?.slackUserName ?? hook.binding?.slackUserId ?? '',
              })
          : bindingState === 'pending'
            ? t('settings.remoteControl.hook.authorizing')
            : isNotInstalled
              ? t('settings.remoteControl.hook.notInstalled.status')
              : t('settings.remoteControl.hook.statusUnbound');
  /**
   * Slack 卡收起行摘要: 关闭态且本地还留有绑定(multi-team 关开关不清绑定)
   * 时给「已关闭 · N 个 workspace 绑定已保留」, 其余用绑定摘要(连接状态由
   * 徽章单独承载, 不再拼接)。
   */
  const slackSummary =
    !hook.enabled && multiUi && hook.bindings.length > 0
      ? t('settings.remoteControl.hook.multi.statusOffKept', { count: hook.bindings.length })
      : bindingLabel;
  // transport 的稳定错误标识换成人话；其它瞬时网络错误保留原文供诊断。
  const errorText =
    hook.lastError === 'not logged in'
      ? t('settings.remoteControl.hook.loginRequired')
      : hook.lastError;
  /**
   * provider-neutral 渠道卡(Telegram / X)的派生展示状态。i18n 前缀按
   * provider 取 settings.remoteControl.hook.<provider>.*, 两块 key 结构平行。
   */
  const providerCardState = (provider: NeutralCardProvider, view: ProviderHookView) => {
    const binding = view.binding;
    const actions = binding?.actions ?? [];
    const state = binding?.state ?? 'none';
    // A configured endpoint is the rollout gate. Capability negotiation starts
    // only after the user enables the provider, so the disabled card cannot
    // depend on an already-received welcome to become discoverable.
    const visible =
      view.url.length > 0 || view.capabilityPending || view.available || view.enabled;
    const confirmed = state === 'confirmed';
    const inProgress =
      view.enabled && (state === 'pending' || state === 'awaiting_confirmation');
    const canStartLink =
      state === 'none' ||
      ((state === 'failed' ||
        state === 'denied' ||
        state === 'expired' ||
        state === 'revoked' ||
        state === 'superseded') &&
        actions.includes('retry'));
    // The switch represents provider ingress, not only the final bind state.
    // Keep it on while the provider is waiting for confirmation so clicking it
    // is an unsurprising cancel/disable action.
    const toggleChecked = view.enabled;
    /** 状态徽章: 只承载传输/能力状态, 绑定细节走摘要与展开区。 */
    const badge: { tone: ChannelBadgeTone; label: string } = !view.enabled
      ? { tone: 'attention', label: t(`settings.remoteControl.hook.${provider}.status.disabled`) }
      : view.status === 'error'
        ? { tone: 'error', label: t('settings.remoteControl.hook.status.error') }
        : view.capabilityPending
          ? { tone: 'progress', label: t(`settings.remoteControl.hook.${provider}.status.checking`) }
          : !view.available
            ? {
                tone: 'attention',
                label: t(`settings.remoteControl.hook.${provider}.status.unavailable`),
              }
            : {
                tone: transportBadgeTone(view.status),
                label: t(`settings.remoteControl.hook.status.${view.status}`),
              };
    /** 绑定态一行(收起行摘要与展开区共用文案)。 */
    const bindingLine =
      view.enabled && view.available && !view.capabilityPending && view.status === 'connected'
        ? confirmed
          ? t(`settings.remoteControl.hook.${provider}.status.confirmed`, {
              user: binding?.principalName ?? binding?.principalId ?? '',
              bot: binding?.scopeName ?? '',
            })
          : t(`settings.remoteControl.hook.${provider}.status.${state}`)
        : null;
    const errorText =
      view.lastError === 'not logged in'
        ? t('settings.remoteControl.hook.loginRequired')
        : view.lastError;
    return { binding, actions, state, visible, confirmed, inProgress, canStartLink, toggleChecked, badge, bindingLine, errorText };
  };
  const workdirCount = Object.keys(hook.workspaces).length;
  const hasActiveSlackBinding = multiUi
    ? activeTeams.length > 0
    : hook.binding?.state === 'confirmed';

  /**
   * 工作目录映射区块(渲染进每张渠道卡的展开区): 目录清单是设备级共享的
   * 同一份 —— 在任一渠道卡里增删目录都作用于全部渠道(区块描述已标注),
   * 运行偏好按渠道隔离, 由所在卡决定传入哪份 prefsState, 因此不再需要
   * 渠道切换 chip。用普通函数而非内联子组件渲染: 内联组件每次渲染都会
   * 重建类型导致子树 remount, 别名输入框会在输入中途失焦。
   */
  const renderWorkdirSection = (
    prefsState: ReturnType<typeof useHookWorkspacePrefs>,
    chatMaxVisibleModelRows?: number,
    /** 非空 = 该卡显示「默认目录」选择器(目前只有 X 传)。 */
    defaultWorkspace?: { value: string | null },
  ) => (
    <>
      <div className="h-px w-full bg-[var(--border-default)]" />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-12 font-medium text-[var(--text-secondary)]">
            {t('settings.remoteControl.hook.form.workspacesCardTitle')}
          </span>
          <span className="text-12 text-[var(--text-tertiary)]">
            · {t('settings.remoteControl.hook.form.workspacesBoundCount', { count: workdirCount })}
          </span>
          {/* (multi-team)偏好归属 team 切换 chip: 多绑定时显示, 选中 team
              决定下方偏好编辑读写哪个 workspace 的那份 */}
          {prefsState.showTeamChip ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('settings.tina.prefs.teamChipAria')}
                className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)]"
              >
                <span className="max-w-40 truncate">
                  {prefsState.teams.find((tm) => tm.teamId === prefsState.selectedTeamId)
                    ?.teamName ??
                    prefsState.selectedTeamId ??
                    ''}
                </span>
                <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {prefsState.teams.map((tm) => (
                  <DropdownMenuItem
                    key={tm.teamId}
                    onClick={() => prefsState.selectTeam(tm.teamId)}
                  >
                    {tm.teamName ?? tm.teamId}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {/* X 专属: 默认工作目录。X 一条推文里没有目录选择面板的位置, 不预设
              就只能永远落在「对话」上、碰不到本地仓库(见 setXDefaultWorkspace)。 */}
          {defaultWorkspace ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('settings.remoteControl.hook.form.defaultWorkspaceAria')}
                className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)]"
              >
                <span className="max-w-40 truncate">
                  {t('settings.remoteControl.hook.form.defaultWorkspaceChip', {
                    name:
                      defaultWorkspace.value ??
                      t('settings.tina.chat.title'),
                  })}
                </span>
                <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void setXDefaultWorkspace(null)}>
                  {t('settings.tina.chat.title')}
                </DropdownMenuItem>
                {Object.keys(hook.workspaces).map((alias) => (
                  <DropdownMenuItem key={alias} onClick={() => void setXDefaultWorkspace(alias)}>
                    {alias}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
          {t('settings.remoteControl.hook.form.workspacesCardDescription')}
        </span>
        {prefsState.hint !== null && (
          <div className="flex items-center gap-2 text-11 text-[var(--text-tertiary)]">
            <span>{prefsState.hint}</span>
            {prefsState.retry !== null && (
              <button
                type="button"
                onClick={prefsState.retry}
                className="rounded-md border border-[var(--border-default)] px-2 py-0.5 text-11 text-[var(--text-secondary)]"
              >
                {t('settings.tina.prefs.retry')}
              </button>
            )}
          </div>
        )}
        {/* 内置「对话」伪目录: 与真实目录同级, 常驻第一位, 不可改名/删除;
            Slack 那头对应保留别名 chat, 偏好与 /model 选 chat 同一份 */}
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5">
          <div className="flex items-center gap-1.5">
            <span className="w-36 shrink-0 px-2.5 py-1.5 text-13 font-medium text-[var(--text-primary)]">
              {t('settings.tina.chat.title')}
            </span>
            <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-tertiary)]">
              {t('settings.tina.chat.description')}
            </span>
          </div>
          <WorkspacePrefsEditor
            alias={HOOK_CHAT_WORKSPACE_ALIAS}
            state={prefsState}
            maxVisibleModelRows={chatMaxVisibleModelRows}
          />
        </div>
        {rows.map((row, i) => (
          <div
            key={row.dir}
            className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5"
          >
            <div className="flex items-center gap-1.5">
              <input
                value={row.alias}
                onChange={(e) => {
                  const next = rows.slice();
                  next[i] = { ...next[i], alias: e.target.value };
                  setRows(next);
                }}
                onBlur={() => void saveWorkspaces(rows)}
                maxLength={32}
                className="shrink-0 w-36 rounded-lg border border-transparent px-2.5 py-1.5 text-13 text-[var(--settings-input-text)] bg-transparent outline-none hover:border-[var(--border-default)] focus:border-[var(--border-default)] transition-colors"
              />
              <button
                type="button"
                onClick={() => void handleChangeDir(i)}
                title={t('settings.remoteControl.hook.form.changeDir')}
                className="min-w-0 flex-1 truncate text-left text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                {row.dir}
              </button>
              <button
                type="button"
                onClick={() => void handleRemoveWorkspace(i)}
                aria-label={t('settings.remoteControl.hook.form.removeWorkspace')}
                className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {/* 会话偏好编辑行: 偏好按别名归属(与 Slack /model 卡同键) */}
            <WorkspacePrefsEditor alias={row.alias.trim()} state={prefsState} />
          </div>
        ))}
        <button
          type="button"
          onClick={() => void handleAddWorkspace()}
          className="flex h-7 w-fit items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <Plus size={12} />
          {t('settings.remoteControl.hook.form.addWorkspace')}
        </button>
      </div>
    </>
  );

  /**
   * provider-neutral 渠道卡(Telegram / X 同构)。用普通函数而非内联子组件
   * 渲染(同 renderWorkdirSection 的理由: 内联组件类型每次渲染重建会导致
   * 子树 remount)。动作按钮完全由 binding.actions 数据驱动 —— X 的 actions
   * 里没有 add_to_group, 加群按钮自然不渲染。
   */
  const renderProviderCard = (provider: NeutralCardProvider) => {
    const view = hook[provider] as ProviderHookView | undefined;
    if (view === undefined) return null; // 旧 main 快照尚无该 provider 字段时不渲染
    const cs = providerCardState(provider, view);
    if (!cs.visible) return null;
    const prefsState = provider === 'telegram' ? telegramPrefsState : xPrefsState;
    return (
      <ImChannelSettingsCard
        id={`cindy-im-${provider}`}
        title={t(
          provider === 'telegram'
            ? 'settings.tina.prefs.providerTelegram'
            : 'settings.tina.prefs.providerX',
        )}
        description={t(`settings.remoteControl.hook.${provider}.description`)}
        routeSummary={cs.bindingLine}
        status={<ChannelStatusBadge tone={cs.badge.tone} label={cs.badge.label} />}
        headerAction={
          <Switch
            checked={cs.toggleChecked}
            disabled={!view.enabled && view.url.length === 0}
            onCheckedChange={(enabled) => handleProviderToggle(provider, enabled)}
            aria-label={t(`settings.remoteControl.hook.${provider}.toggleAria`)}
          />
        }
        expanded={expandedCard === provider}
        onToggle={() => toggleCard(provider)}
      >
        <div className="flex flex-col gap-2">
          {!view.enabled ? (
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t(`settings.remoteControl.hook.${provider}.disabledHint`)}
            </span>
          ) : null}

          {/* 绑定进度/结果一行(完成关联引导、失败原因等; 已关联的摘要由
              收起行承载, 展开区不重复) */}
          {cs.bindingLine !== null && !cs.confirmed ? (
            <span
              className={`text-11 leading-relaxed ${
                cs.state === 'failed' ||
                cs.state === 'denied' ||
                cs.state === 'expired' ||
                cs.state === 'superseded'
                  ? 'text-[var(--error-fg)]'
                  : 'text-[var(--text-tertiary)]'
              }`}
            >
              {cs.bindingLine}
            </span>
          ) : null}

          {view.enabled &&
          view.status === 'error' &&
          cs.errorText &&
          cs.errorText !== cs.badge.label ? (
            <span className="text-11 leading-relaxed text-[var(--error-fg)]">{cs.errorText}</span>
          ) : null}

          {view.enabled && view.available ? (
            <div className="flex flex-wrap items-center gap-2">
              {cs.inProgress && cs.binding?.connectUrl ? (
                <>
                  {cs.actions.includes('open_connect_url') ? (
                    <button
                      type="button"
                      onClick={() => handleProviderOpen(provider, 'connect')}
                      className={pillBtn}
                    >
                      {t(`settings.remoteControl.hook.${provider}.openApp`)}
                    </button>
                  ) : null}
                  {cs.actions.includes('copy_connect_url') ? (
                    <button
                      type="button"
                      onClick={() => void handleCopyProviderLink(provider)}
                      className={pillBtn}
                    >
                      {t('settings.remoteControl.hook.binding.copyLink')}
                    </button>
                  ) : null}
                </>
              ) : null}
              {cs.inProgress && cs.actions.includes('cancel') ? (
                <button
                  type="button"
                  onClick={() =>
                    runHookAction(() => window.electronAPI.hookControl.providerBindCancel(provider))
                  }
                  className={pillBtn}
                >
                  {t(`settings.remoteControl.hook.${provider}.cancel`)}
                </button>
              ) : null}
              {cs.confirmed ? (
                <>
                  {cs.actions.includes('open_provider') ? (
                    <button
                      type="button"
                      onClick={() => handleProviderOpen(provider, 'provider')}
                      className={pillBtn}
                    >
                      {t(`settings.remoteControl.hook.${provider}.openBot`)}
                    </button>
                  ) : null}
                  {cs.actions.includes('add_to_group') ? (
                    <button
                      type="button"
                      onClick={() => handleProviderOpen(provider, 'add-to-group')}
                      className={pillBtn}
                    >
                      {t(`settings.remoteControl.hook.${provider}.addToGroup`)}
                    </button>
                  ) : null}
                  {cs.actions.includes('revoke') ? (
                    <button
                      type="button"
                      onClick={() => void handleProviderUnlink(provider)}
                      className={pillBtn}
                    >
                      {t(`settings.remoteControl.hook.${provider}.unlink`)}
                    </button>
                  ) : null}
                </>
              ) : cs.canStartLink ? (
                <button
                  type="button"
                  onClick={() =>
                    runHookAction(() => window.electronAPI.hookControl.providerBindStart(provider))
                  }
                  className={pillBtn}
                >
                  {t(
                    cs.state === 'none'
                      ? `settings.remoteControl.hook.${provider}.connect`
                      : `settings.remoteControl.hook.${provider}.retry`,
                  )}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 工作目录映射(清单共享, 偏好取本 provider 那份) */}
          {view.enabled
            ? renderWorkdirSection(
                prefsState,
                undefined,
                provider === 'x' ? { value: view.defaultWorkspace } : undefined,
              )
            : null}
        </div>
      </ImChannelSettingsCard>
    );
  };


  return (
    <div className="flex flex-col gap-3">
      <p className="text-12 text-[var(--text-tertiary)]">
        {t('settings.remoteControl.hook.description')}
      </p>

      {/* ── Slack 渠道卡 ─────────────────────────────────────────────── */}
      <ImChannelSettingsCard
        id="cindy-im-slack"
        title={t('settings.tina.prefs.providerSlack')}
        description={t('settings.remoteControl.hook.slackDescription')}
        routeSummary={slackSummary}
        status={
          <ChannelStatusBadge
            tone={transportBadgeTone(hook.status)}
            label={t(`settings.remoteControl.hook.status.${hook.status}`)}
          />
        }
        headerAction={
          <Switch
            checked={toggleChecked}
            onCheckedChange={(next) => {
              // 在途态(视觉关、意图开)点击会回传 next=true, 语义是"取消本轮
              // 授权/等待"而非重复开启 —— 统一关回; 其余情况按点击意图直传
              handleToggle(toggleInProgress ? false : next);
            }}
            aria-label={t('settings.remoteControl.hook.toggleAria')}
          />
        }
        expanded={expandedCard === 'slack'}
        onToggle={() => toggleCard('slack')}
      >
        <div className="flex flex-col gap-2">
          {/* 传输层错误 / 待机说明(收起态由徽章给概要, 详情在展开区) */}
          {hook.status === 'error' && errorText ? (
            <span className="text-11 leading-relaxed text-[var(--error-fg)]">{errorText}</span>
          ) : hook.status === 'standby' ? (
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.standbyHint')}
            </span>
          ) : null}

          {/* 关闭态引导(失败/未安装的原因行会一并跟在下方) */}
          {!hook.enabled ? (
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.slackDisabledHint')}
            </span>
          ) : null}

          {/* 单绑定授权中: 复制授权链接 —— 远程控制时 openExternal 落被控机,
              复制到本机浏览器完成授权是兜底通路(规则 26)。浏览器已自动弹出,
              摘要的「授权中…」即进度反馈; multi-team 列表模式的复制按钮在
              下方 pending 行里 */}
          {hook.enabled && !multiUi && bindingState === 'pending' && hook.binding?.authorizeUrl ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--border-default)] px-2.5 py-2">
              <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-tertiary)]">
                {t('settings.remoteControl.hook.authorizing')}
              </span>
              <button type="button" onClick={() => void handleCopyLink()} className={pillBtn}>
                {t('settings.remoteControl.hook.binding.copyLink')}
              </button>
            </div>
          ) : null}

          {/* 授权检出 workspace 未安装 App(bind.update failed + reason=not-installed):
              专属引导行 —— 安装是能用的前提, 给「安装 Slack App」按钮(302 直跳
              Slack 安装授权页)+ 说明。安装成功与否无从主动探测, 装完重开开关走
              新一轮授权即验证。远程控制时 openExternal 落被控机, 「复制链接」到
              本机浏览器完成安装是兜底通路(规则 26)。multi-team 首绑失败时
              manager 会 setEnabled(false) 弹回开关、列表区块随 enabled 消失, 故
              这段独立于列表渲染(带「取消」入口的版本在下方列表区块内) */}
          {isNotInstalled && (!multiUi || !hook.enabled) ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                  {t('settings.remoteControl.hook.notInstalled.title')}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (installUrl) void window.electronAPI.openExternal(installUrl);
                  }}
                  className={pillBtn}
                >
                  {t('settings.remoteControl.hook.installApp')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyInstallLink()}
                  className={pillBtn}
                >
                  {t('settings.remoteControl.hook.binding.copyLink')}
                </button>
              </div>
              <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
                {hook.enabled
                  ? t('settings.remoteControl.hook.notInstalled.waitingHint')
                  : t('settings.remoteControl.hook.notInstalled.hint')}
              </span>
            </div>
          ) : null}

          {/* 取消授权 / 授权失败 / 超时 / 被新设备顶掉: 开关已自动弹回, 显示原因;
              绑定记录保留, 重新打开开关即自动重连并(未绑定时)重新发起授权 */}
          {!multiUi && isBindingFailure && !isNotInstalled ? (
            <div className="flex flex-col gap-1">
              <span className="text-11 leading-relaxed text-[var(--error-fg)]">
                {hook.binding?.message ??
                  t(`settings.remoteControl.hook.binding.state.${bindingState}`)}
              </span>
              <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
                {t('settings.remoteControl.hook.binding.retryHint')}
              </span>
            </div>
          ) : null}

          {/* (multi-team)首绑终止态兜底(取消授权/超时/失败, 非未安装): 首绑
              失败时列表区块随 enabled 消失, 原因行必须独立渲染, 否则用户只
              看到开关静默弹回。已有绑定时终止态行由列表内对应行承载 */}
          {multiUi &&
          !hook.enabled &&
          !isNotInstalled &&
          hook.pendingBind !== null &&
          hook.pendingBind.state !== 'pending' ? (
            <div className="flex flex-col gap-1">
              <span className="text-11 leading-relaxed text-[var(--error-fg)]">
                {hook.pendingBind.message ??
                  t(`settings.remoteControl.hook.binding.state.${hook.pendingBind.state}`)}
              </span>
              <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
                {t('settings.remoteControl.hook.binding.retryHint')}
              </span>
            </div>
          ) : null}

          {/* (multi-team)workspace 绑定列表: 每绑定一行(team + 用户 + 状态
              标注 + 解绑), displaced 行给「重新绑定」; 在途授权挂列表尾部
              (授权中 + 复制链接 + 取消), 未安装引导行挂 pending 行下;
              「添加」入口仅 server 宣告 multi-team 时显示 */}
          {hook.enabled && multiUi ? (
            <div className="flex flex-col gap-1.5">
              {hook.bindings.map((b) => (
                <div
                  key={b.teamId}
                  className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] px-2.5 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                      {b.teamName ?? b.teamId}
                    </span>
                    <span className="truncate text-12 text-[var(--text-tertiary)]">
                      @{b.slackUserName ?? b.slackUserId}
                    </span>
                  </div>
                  {b.displaced ? (
                    <>
                      {/* 被另一台设备顶掉: 标注 + 重新绑定(pin 到该 team 的授权页) */}
                      <span className="shrink-0 text-11 text-[var(--error-fg)]">
                        {t('settings.remoteControl.hook.multi.displaced')}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          runHookAction(() => window.electronAPI.hookControl.rebindTeam(b.teamId))
                        }
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.multi.rebind')}
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleRemoveBinding(b)}
                    aria-label={t('settings.remoteControl.hook.multi.removeAria')}
                    className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {hook.pendingBind?.state === 'pending' ? (
                <div className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--border-default)] px-2.5 py-2">
                  <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-tertiary)]">
                    {t('settings.remoteControl.hook.authorizing')}
                  </span>
                  {hook.pendingBind.authorizeUrl ? (
                    <button type="button" onClick={() => void handleCopyLink()} className={pillBtn}>
                      {t('settings.remoteControl.hook.binding.copyLink')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      runHookAction(() => window.electronAPI.hookControl.cancelPendingBind())
                    }
                    className={pillBtn}
                  >
                    {t('settings.remoteControl.hook.multi.cancelPending')}
                  </button>
                </div>
              ) : null}
              {/* 未安装引导行(添加的 workspace 没装 App; 确认框逻辑与单绑定共用) */}
              {isNotInstalled ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                      {t('settings.remoteControl.hook.notInstalled.title')}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (installUrl) void window.electronAPI.openExternal(installUrl);
                      }}
                      className={pillBtn}
                    >
                      {t('settings.remoteControl.hook.installApp')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyInstallLink()}
                      className={pillBtn}
                    >
                      {t('settings.remoteControl.hook.binding.copyLink')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        runHookAction(() => window.electronAPI.hookControl.cancelPendingBind())
                      }
                      className={pillBtn}
                    >
                      {t('settings.remoteControl.hook.multi.cancelPending')}
                    </button>
                  </div>
                  <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
                    {t('settings.remoteControl.hook.notInstalled.waitingHint')}
                  </span>
                </div>
              ) : null}
              {/* 添加/重绑的终止态(取消授权/超时/失败, 非未安装): 一行原因 + 可清除 */}
              {hook.pendingBind !== null &&
              hook.pendingBind.state !== 'pending' &&
              !isNotInstalled ? (
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                    {hook.pendingBind.reason === HOOK_BIND_REASON_ALREADY_BOUND
                      ? t('settings.remoteControl.hook.multi.alreadyBound', {
                          team:
                            hook.bindings.find((b) => b.teamId === hook.pendingBind?.teamId)
                              ?.teamName ??
                            hook.pendingBind.teamId ??
                            '',
                        })
                      : (hook.pendingBind.message ??
                        t(`settings.remoteControl.hook.binding.state.${hook.pendingBind.state}`))}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      runHookAction(() => window.electronAPI.hookControl.cancelPendingBind())
                    }
                    className={pillBtn}
                  >
                    {t('settings.remoteControl.hook.multi.dismiss')}
                  </button>
                </div>
              ) : null}
              {hook.serverMultiTeam ? (
                <button
                  type="button"
                  onClick={() => runHookAction(() => window.electronAPI.hookControl.addBinding())}
                  className="flex h-7 w-fit items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <Plus size={12} />
                  {t('settings.remoteControl.hook.multi.addWorkspace')}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 单绑定已完成: 说明开关的反向语义(关 = 解绑, 重开需再授权),
              避免展开区空白 */}
          {hook.enabled && !multiUi && bindingState === 'confirmed' ? (
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.slackBoundHint')}
            </span>
          ) : null}

          {hasActiveSlackBinding ? (
            <>
              <div className="h-px w-full bg-[var(--border-default)]" />
              <div className="flex flex-col gap-1.5">
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('settings.remoteControl.hook.lifecycleAnnouncement.label')}
                </span>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-13 text-[var(--text-primary)]">
                      {t('settings.remoteControl.hook.lifecycleAnnouncement.cellLabel')}
                    </span>
                    <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
                      {t('settings.remoteControl.hook.lifecycleAnnouncement.hint')}
                    </span>
                  </div>
                  <Switch
                    checked={hook.lifecycleAnnouncement}
                    onCheckedChange={handleLifecycleAnnouncementToggle}
                    aria-label={t('settings.remoteControl.hook.lifecycleAnnouncement.label')}
                  />
                </div>
              </div>
            </>
          ) : null}

          {/* 工作目录映射(清单共享, 偏好取 Slack 那份) */}
          {hook.enabled ? renderWorkdirSection(slackPrefsState, 6) : null}
        </div>
      </ImChannelSettingsCard>

      {/* ── provider-neutral 渠道卡(Telegram / X, 同构渲染) ─────────── */}
      {renderProviderCard('telegram')}
      {renderProviderCard('x')}
    </div>
  );
}
