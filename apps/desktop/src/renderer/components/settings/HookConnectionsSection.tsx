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

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { ImDefaultAgentKind, ImDefaultSettingsState } from '../../../shared/imDefaultSettings';
import { acknowledgeXUsage, isXUsageAcknowledged } from '@/state/xUsageNotice';
import { XUsageGuide } from './XUsageGuide';
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
import {
  TelegramBehaviorSettings,
  TelegramGroupActivationSettings,
} from './TelegramBehaviorSettings';

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

/**
 * 存量 global override 的收尾入口（**只对升级用户可见**）。
 *
 * 官方卡的「新对话配置」区块删掉后, 用户此前在那里改过的 agent / model / effort 仍以
 * global scope 落在盘上, 并继续被 session-runner(`readImDefaultSettings(undefined)`)与
 * 目录行的生效值解析当作 fallback —— 于是旧设置照旧影响所有没显式配置的目录、以及
 * 以后新加的目录, 而用户再也看不到、也改不了它(review 指出)。
 *
 * 不选"静默清除": 那会在升级瞬间悄悄改掉用户已保存的 agent / 模型。也不选"把区块留
 * 着": 那等于把这次要消除的重叠原样放回来。折中是**仅当确实存在 override 时**露出这
 * 一条: 说清它还在生效、显示它是什么、给一个恢复默认的按钮; 恢复后它永久消失, 从未
 * 设过的用户一次都看不到。
 *
 * **两张 provider-neutral 卡都挂**: global scope 是官方 Telegram 与 X 共用的那一份
 * (`session-runner` 对两者都读 `readImDefaultSettings(undefined)`)。只挂在 Telegram 上,
 * 曾设过 override 后关掉 Telegram、只用 X 的升级用户就没有入口, 旧值继续被 X 任务消费,
 * 而他只能猜"要重新打开 Telegram 才能清"(review 指出)。
 */
/** 「恢复默认」实际会清掉的一条 override(供 UI 逐条列出; 纯数据, 文案在组件里)。 */
export type LegacyOverrideRow =
  | { kind: 'agentKind'; current: string; fallback: string }
  | { kind: 'permissionMode'; current: string; fallback: string }
  | {
      kind: 'agent';
      agent: string;
      fields: Array<{ field: 'model' | 'effort' | 'source'; current: string; fallback: string }>;
    };

/**
 * 把 `customizedKeys` 展开成「这次会清掉什么」的完整清单。
 *
 * 为什么不能只显示当前 agentKind 的 model: `imDefaultSettingsReset()` 清的是**整个**
 * global scope, 包含 `agents` 里其它 agent 的 model / effort / 来源。用户可能曾切到另一个
 * agent 改过这些再切回来 —— 那些值此刻正被"显式选了该 agent、但模型档位仍跟随默认"的目录
 * 消费, 只报当前 agent 一行就等于让他在不知道范围的情况下改掉目录路由(review 指出)。
 */
export function legacyOverrideRows(state: ImDefaultSettingsState): LegacyOverrideRow[] {
  const rows: LegacyOverrideRow[] = [];
  for (const key of state.customizedKeys) {
    if (key === 'agentKind') {
      rows.push({
        kind: 'agentKind',
        current: state.agentKind,
        fallback: state.defaults.agentKind,
      });
      continue;
    }
    if (key === 'permissionMode') {
      rows.push({
        kind: 'permissionMode',
        current: state.permissionMode,
        fallback: state.defaults.permissionMode,
      });
      continue;
    }
    if (!key.startsWith('agents.')) continue;
    const agent = key.slice('agents.'.length) as ImDefaultAgentKind;
    const current = state.agents[agent];
    const fallback = state.defaults.agents[agent];
    if (!current || !fallback) continue;
    // 只列真的不一样的子字段 —— 把三项全列出来会让人以为都被改过。
    const fields: Array<{
      field: 'model' | 'effort' | 'source';
      current: string;
      fallback: string;
    }> = [];
    if (current.model !== fallback.model) {
      fields.push({ field: 'model', current: current.model, fallback: fallback.model });
    }
    if (current.effort !== fallback.effort) {
      fields.push({ field: 'effort', current: current.effort, fallback: fallback.effort });
    }
    if (current.providerId !== fallback.providerId) {
      fields.push({
        field: 'source',
        current: current.providerId ?? '',
        fallback: fallback.providerId ?? '',
      });
    }
    if (fields.length > 0) rows.push({ kind: 'agent', agent, fields });
  }
  return rows;
}

function useLegacyGlobalDefaults(onCleared: () => void): {
  state: ImDefaultSettingsState | null;
  pending: boolean;
  restore: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [state, setState] = useState<ImDefaultSettingsState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void window.electronAPI.maker
      .imDefaultSettingsGet()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const restore = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      setState(await window.electronAPI.maker.imDefaultSettingsReset());
      // 两张卡的目录行都以 global scope 为生效值解析源 —— 只刷新当前这张会让另一张
      // 继续显示磁盘上已经不存在的旧默认(review 指出)。
      onCleared();
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [onCleared, pending, t]);

  return { state, pending, restore };
}

/** 上面那条提示的纯展示部分(状态由 useLegacyGlobalDefaults 单点持有, 两张卡共用)。 */
function LegacyGlobalDefaultsNotice({
  state,
  pending,
  onRestore,
}: {
  state: ImDefaultSettingsState | null;
  pending: boolean;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  if (state === null || !state.isCustomized) return null;
  return (
    <div
      data-testid="hook-legacy-global-defaults"
      className="flex flex-col gap-1.5 rounded-xl border border-[var(--border-default)] p-2.5"
    >
      <span className="text-12 font-medium text-[var(--text-secondary)]">
        {t('settings.remoteControl.hook.form.legacyDefaultsTitle')}
      </span>
      <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
        {t('settings.remoteControl.hook.form.legacyDefaultsDescription')}
      </span>
      {/* 逐条列出**这次实际会清掉的全部** override(见 legacyOverrideRows 注释):
          只报当前 agent 的模型, 等于让用户在不知道范围的情况下改掉目录路由。 */}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {legacyOverrideRows(state).map((row) => (
          <li
            key={row.kind === 'agent' ? `agent:${row.agent}` : row.kind}
            data-testid="hook-legacy-global-defaults-row"
            className="text-11 leading-relaxed text-[var(--text-tertiary)]"
          >
            {row.kind === 'agent'
              ? t('settings.remoteControl.hook.form.legacyDefaultsRowAgent', {
                  agent: row.agent,
                  fields: row.fields
                    .map((f) =>
                      t(`settings.remoteControl.hook.form.legacyDefaultsField.${f.field}`, {
                        current:
                          f.current ||
                          t('settings.remoteControl.hook.form.legacyDefaultsSourceFollowsGlobal'),
                        fallback:
                          f.fallback ||
                          t('settings.remoteControl.hook.form.legacyDefaultsSourceFollowsGlobal'),
                      }),
                    )
                    .join(t('settings.remoteControl.hook.form.legacyDefaultsFieldSeparator')),
                })
              : t(`settings.remoteControl.hook.form.legacyDefaultsRow.${row.kind}`, {
                  current: row.current,
                  fallback: row.fallback,
                })}
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="hook-legacy-global-defaults-restore"
        onClick={onRestore}
        disabled={pending}
        className="mt-0.5 flex h-7 w-fit items-center rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
      >
        {t('settings.defaults.restore')}
      </button>
    </div>
  );
}

/**
 * 单选组的方向键导航(WAI-ARIA radio group: 方向键同时移动焦点与选中项)。
 *
 * roving tabIndex 只解决"Tab 一次进组"; 组内换项必须靠方向键 —— 只给 tabIndex 的话
 * 键盘用户进组后就再也切不出去(review 指出)。禁用项(未落盘的新目录行)跳过。
 * 复用各项自己的 onClick 完成写入, 不在这里重复一条写路径。
 */
function handleRadioGroupKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  // 单选组容器同时包着别名输入框与「换目录」按钮 —— 事件不是从 radio 冒上来的就一律
  // 放行。漏这一步会让在别名输入框里按 ←/→ 移动光标变成"焦点跳到相邻 radio 并点击它",
  // 于是用户改个名字就把默认工作目录换成了另一个(review 指出)。
  if ((e.target as HTMLElement).closest('[role="radio"]') === null) return;
  const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  const backward = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
  if (!forward && !backward) return;
  const options = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'),
  ];
  if (options.length === 0) return;
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  // 焦点还不在任何一项上(例如刚点进容器): 从选中项开始, 没有选中项就从头。
  const from =
    current >= 0
      ? current
      : Math.max(
          0,
          options.findIndex((o) => o.getAttribute('aria-checked') === 'true'),
        );
  const next = options[(from + (forward ? 1 : -1) + options.length) % options.length];
  e.preventDefault();
  next.focus();
  next.click();
}

/**
 * 目录行头部的「设为默认工作目录」单选(row 形态; Telegram 用)。
 *
 * 视觉沿用 LanguageSection 的选中态范式与 --settings-menu-* 语义 token —— 双模式
 * 由 token 自动覆盖, 不写任何硬编码色; 选中用对勾, 与 DESIGN.md §16.3 协议 radio
 * 的仓内口径一致。模块级组件而非内联: 内联组件每次渲染都会重建类型导致子树
 * remount, 别名输入框会在输入中途失焦(同 renderWorkdirSection 的理由)。
 */
function DefaultWorkspaceRadio({
  selected,
  label,
  onSelect,
  disabled = false,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
  /** true = 这一行还没落盘, 不能当默认目录(别名尚未进 workspaces)。 */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      title={label}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
        selected
          ? 'border-[var(--settings-menu-border-selected)] bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]'
          : 'border-[var(--border-default)] text-transparent hover:border-[var(--settings-menu-border-selected)]',
        disabled && 'cursor-not-allowed opacity-40 hover:border-[var(--border-default)]',
      )}
    >
      <Check size={12} aria-hidden />
    </button>
  );
}

/** 小号胶囊按钮(「复制链接 / 安装 Slack App」共用)。 */
const pillBtn =
  'flex h-6 shrink-0 items-center rounded-full border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50';

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
  const [slackAuthActionPending, setSlackAuthActionPending] = useState(false);
  const slackAuthActionInFlightRef = useRef(false);
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

  /** Slack 授权相关动作共用一个门，避免开关/添加/重绑交叉点击创建多轮 OAuth。 */
  const runSlackAuthAction = useCallback(
    (
      action: () => Promise<{ hook: SlackHookView }>,
      errorKey:
        | 'settings.remoteControl.hook.toast.toggleFailed'
        | 'settings.remoteControl.hook.toast.actionFailed',
      expand = false,
    ) => {
      if (slackAuthActionInFlightRef.current) return;
      slackAuthActionInFlightRef.current = true;
      setSlackAuthActionPending(true);
      if (expand) setExpandedCard('slack');
      const requestedAtRevision = ++viewRevisionRef.current;
      void action()
        .then((res) => {
          if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
        })
        .catch(() => toast.error(t(errorKey)))
        .finally(() => {
          slackAuthActionInFlightRef.current = false;
          setSlackAuthActionPending(false);
        });
    },
    [applyView, t],
  );

  /**
   * 开关即绑定(即时生效): 开 = 连接, main 连上后自动拉起浏览器 Slack 授权;
   * 关 = 解除绑定并断开(main 发 bind.revoke), 再开需重新授权。
   */
  const handleToggle = useCallback(
    (enabled: boolean) => {
      runSlackAuthAction(
        () => window.electronAPI.hookControl.setEnabled(enabled),
        'settings.remoteControl.hook.toast.toggleFailed',
        enabled,
      );
    },
    [runSlackAuthAction],
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

  /** Terminal Slack authorization states restart through the matching main-process flow. */
  const handleReauthorize = useCallback(
    (mode: 'enable' | 'add' | 'rebind', teamId?: string) => {
      const action =
        mode === 'enable'
          ? () => window.electronAPI.hookControl.setEnabled(true)
          : mode === 'rebind' && teamId
            ? () => window.electronAPI.hookControl.rebindTeam(teamId)
            : () => window.electronAPI.hookControl.addBinding();
      runSlackAuthAction(action, 'settings.remoteControl.hook.toast.actionFailed', true);
    },
    [runSlackAuthAction],
  );

  /**
   * 默认工作目录写入(Telegram / X)。
   *
   * 生效顺序恒为 **会话显式映射 > 这里的默认值 > 「对话」**, 判定在 hook server。
   * X 一次交互只允许回一条公开推文, 没有承载目录选择面板的位置; Telegram 虽有
   * inline keyboard 可以当场 /workspace, 但那是**每会话各自**设的 —— 用户在设置页
   * 绑好目录后进一个新群, agent 仍在无仓库模式跑, 与他的预期不符。
   */
  const setProviderDefaultWorkspace = useCallback(
    async (provider: 'telegram' | 'x', alias: string | null) => {
      try {
        const requestedAtRevision = ++viewRevisionRef.current;
        const res = await window.electronAPI.hookControl.setProviderDefaultWorkspace(
          provider,
          alias,
        );
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
      runHookAction(() => window.electronAPI.hookControl.setLifecycleAnnouncement(enabled), {
        localizedErrorOnly: true,
      });
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
        runSlackAuthAction(
          () => window.electronAPI.hookControl.cancelPendingBind(),
          'settings.remoteControl.hook.toast.actionFailed',
        );
      } else {
        handleToggle(false);
      }
    })();
  }, [awaitingInstall, confirm, handleToggle, runSlackAuthAction, t]);

  /**
   * X 的「用法与公开风险」确认门:绑定成功那一刻拦一次, 让用户明确点过「我明白」。
   *
   * 为什么不只靠卡内那一节:X 的回复是**公开推文**, 而且所有 X 任务都落在用户设的默认
   * 工作目录里(agent 能读写其中文件, 结论会公开回帖)—— 这两条后果只写在展开区里,
   * 不展开的人就永远看不到, 而它们恰恰是开启前就该知道的。
   *
   * 只在「未确认 → confirmed」那一沿弹一次:
   *   - promptedPrincipalRef 记住正在弹或已弹过的 principalId, 状态广播导致的重渲染
   *     不重复弹(同上方"等安装"确认框的 ref 用法);
   *   - 记账落在 principalId 上, 所以换绑到另一个 X 账号会再确认一次(新账号 = 新的
   *     公开面), 同账号解绑重绑则不打扰;
   *   - **只有真的点了「我明白」才记账**。confirm-dialog 在 Esc / 点遮罩时 resolve 成
   *     cancel(即 ok=false), 那种情况下用户并没有读到告知, 下次仍该弹。
   */
  const xBinding = hook?.x?.binding ?? null;
  const xConfirmedPrincipalId =
    xBinding !== null && xBinding.state === 'confirmed' ? xBinding.principalId : null;
  const promptedXPrincipalRef = useRef<string | null>(null);
  useEffect(() => {
    if (xConfirmedPrincipalId === null) {
      // 解绑 / 转入非 confirmed: 清掉本沿的记录, 下次绑定成功可以重新判定
      promptedXPrincipalRef.current = null;
      return;
    }
    if (promptedXPrincipalRef.current === xConfirmedPrincipalId) return;
    if (isXUsageAcknowledged(xConfirmedPrincipalId)) return;
    promptedXPrincipalRef.current = xConfirmedPrincipalId;
    void (async () => {
      const ok = await confirm({
        title: t('settings.remoteControl.hook.x.guide.ackTitle'),
        content: <XUsageGuide />,
        confirmText: t('settings.remoteControl.hook.x.guide.ackConfirm'),
        showCancel: false,
        // 主操作非破坏性(只是"我明白"), 焦点直接落在它上面
        autoFocusConfirm: true,
        maxWidth: 520,
      });
      if (!ok) {
        // Esc / 遮罩关掉 = 没读到, 允许下次再弹
        if (promptedXPrincipalRef.current === xConfirmedPrincipalId) {
          promptedXPrincipalRef.current = null;
        }
        return;
      }
      // 卸载后也照常落盘: 用户确实点过了, 少记一次会让他下次再被拦一遍
      acknowledgeXUsage(xConfirmedPrincipalId);
    })();
  }, [xConfirmedPrincipalId, confirm, t]);

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
  // 存量 global override(见 useLegacyGlobalDefaults 上方注释): 状态单点持有, 两张
  // provider-neutral 卡共用同一份; 清掉后两张卡的生效值解析源都要重读。
  const reloadGlobalDefaults = useCallback(() => {
    void telegramPrefsState.reloadImDefaults();
    void xPrefsState.reloadImDefaults();
  }, [telegramPrefsState, xPrefsState]);
  const legacyGlobalDefaults = useLegacyGlobalDefaults(reloadGlobalDefaults);

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
    void window.electronAPI.hookControl
      .openProviderAction(provider, action)
      .catch((err: unknown) => {
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
  // 顶部状态行的绑定态独立于 transport: 已绑定账号在重连/错误/待机时仍是已绑定。
  // 失败态走下方错误行; "等安装"单独给「待安装 App」。multi-team 分支:
  // 单个绑定沿用「已绑定 {team} @{user}」; 多个绑定/有待处理项给数量摘要。
  const bindingLabel = multiUi
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
  const slackBindingSummary =
    !hook.enabled && multiUi && hook.bindings.length > 0
      ? t('settings.remoteControl.hook.multi.statusOffKept', { count: hook.bindings.length })
      : bindingLabel;
  const slackSummary = t('settings.remoteControl.hook.accountStatus', {
    status: slackBindingSummary ?? t('settings.remoteControl.hook.statusUnbound'),
  });
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
    const visible = view.url.length > 0 || view.capabilityPending || view.available || view.enabled;
    const confirmed = state === 'confirmed';
    const inProgress = view.enabled && (state === 'pending' || state === 'awaiting_confirmation');
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
          ? {
              tone: 'progress',
              label: t(`settings.remoteControl.hook.${provider}.status.checking`),
            }
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
    return {
      binding,
      actions,
      state,
      visible,
      confirmed,
      inProgress,
      canStartLink,
      toggleChecked,
      badge,
      bindingLine,
      errorText,
    };
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
  /**
   * 该目录当前**已保存**的别名(null = 这一行还没落盘, 或别名正在编辑中)。
   *
   * 默认工作目录写的是别名, 而 store 只接受 workspaces 里已有的别名 —— 所以选中态
   * 与写入都必须以落盘的那份映射为准, 不能用别名输入框的临时值。目录路径在一次渲染
   * 里是稳定键(rows 就按 dir 去重), 用它反查别名。
   */
  const savedAliasOf = (dir: string): string | null =>
    Object.keys(hook.workspaces).find((alias) => hook.workspaces[alias] === dir) ?? null;

  const renderWorkdirSection = (
    prefsState: ReturnType<typeof useHookWorkspacePrefs>,
    chatMaxVisibleModelRows?: number,
    /**
     * 非空 = 该卡显示默认工作目录选择器。
     * `chip` = 标题行右侧的下拉 chip(X 沿用); `row` = 目录行内的选中态单选
     * (Telegram: 目录本来就一行一个, 行内选中比再开一个下拉更直白)。
     */
    defaultWorkspace?: {
      value: string | null;
      mode: 'chip' | 'row';
      provider: 'telegram' | 'x';
    },
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
          {/* chip 形态(X): 一条推文里没有目录选择面板的位置, 不预设就只能永远
              落在「对话」上、碰不到本地仓库(见 setProviderDefaultWorkspace)。 */}
          {defaultWorkspace?.mode === 'chip' ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('settings.remoteControl.hook.form.defaultWorkspaceAria')}
                className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)]"
              >
                <span className="max-w-40 truncate">
                  {t('settings.remoteControl.hook.form.defaultWorkspaceChip', {
                    name: defaultWorkspace.value ?? t('settings.tina.chat.title'),
                  })}
                </span>
                <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => void setProviderDefaultWorkspace(defaultWorkspace.provider, null)}
                >
                  {t('settings.tina.chat.title')}
                </DropdownMenuItem>
                {Object.keys(hook.workspaces).map((alias) => (
                  <DropdownMenuItem
                    key={alias}
                    onClick={() =>
                      void setProviderDefaultWorkspace(defaultWorkspace.provider, alias)
                    }
                  >
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
        {/* row 形态才需要解释"选中即默认"这层语义, 并把权限档的后果说在选之前。
            文案不用方位词指代("下面的目录") —— 同一区块也渲染进确认门弹窗。 */}
        {defaultWorkspace?.mode === 'row' ? (
          <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
            {t('settings.remoteControl.hook.form.defaultWorkspaceRowHint')}
          </span>
        ) : null}
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
        {/* row 形态: 整个目录清单是一组单选 —— 选中的那个就是默认工作目录。
            aria 分组挂在这里, 各行头部的 role="radio" 按钮是它的选项。 */}
        <div
          className="flex flex-col gap-2"
          {...(defaultWorkspace?.mode === 'row'
            ? {
                role: 'radiogroup',
                'aria-label': t('settings.remoteControl.hook.form.defaultWorkspaceAria'),
                onKeyDown: handleRadioGroupKeyDown,
              }
            : {})}
        >
          {/* 内置「对话」伪目录: 与真实目录同级, 常驻第一位, 不可改名/删除;
            Slack 那头对应保留别名 chat, 偏好与 /model 选 chat 同一份 */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5">
            <div className="flex items-center gap-1.5">
              {defaultWorkspace?.mode === 'row' ? (
                <DefaultWorkspaceRadio
                  selected={defaultWorkspace.value === null}
                  label={t('settings.remoteControl.hook.form.defaultWorkspaceRadioAria', {
                    name: t('settings.tina.chat.title'),
                  })}
                  onSelect={() => void setProviderDefaultWorkspace(defaultWorkspace.provider, null)}
                />
              ) : null}
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
                {defaultWorkspace?.mode === 'row' ? (
                  <DefaultWorkspaceRadio
                    // **只认已保存的 alias → dir 映射**, 不看输入框里的临时值: 别名改了
                    // 但还没 blur 落盘时, 拿它当选中判据会把未保存的名字显示成已选中,
                    // 点下去还会把 workspaces 里不存在的别名发给 store(直接抛校验错)。
                    // 未保存的新行(还没有对应映射)不给选 —— 先落盘再设默认。
                    selected={
                      savedAliasOf(row.dir) !== null &&
                      defaultWorkspace.value === savedAliasOf(row.dir)
                    }
                    disabled={savedAliasOf(row.dir) === null}
                    label={t('settings.remoteControl.hook.form.defaultWorkspaceRadioAria', {
                      name: savedAliasOf(row.dir) ?? row.alias.trim(),
                    })}
                    onSelect={() => {
                      const saved = savedAliasOf(row.dir);
                      if (saved === null) return;
                      void setProviderDefaultWorkspace(defaultWorkspace.provider, saved);
                    }}
                  />
                ) : null}
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
        </div>
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

          {/* X 专属: 用法与公开风险。两个刻意的选择 ——
              · 放在工作目录区**之前**: 风险那条讲的就是这张卡上那个默认工作目录,
                顺序必须是先看到后果再碰控件。注意这只是**排布**上的先后 ——
                文案本身不许用方位指代(「下面」/「below」), 因为同一组件也渲染进
                确认门弹窗, 那里根本没有目录选择器;
              · **不按 view.enabled / cs.confirmed 收起**: 正在评估要不要打开的人
                最需要看到「回帖是公开的」, 那时候两个条件都还不成立。 */}
          {provider === 'x' ? <XUsageGuide /> : null}

          {/* 工作目录映射(清单共享, 偏好取本 provider 那份) */}
          {view.enabled
            ? renderWorkdirSection(prefsState, undefined, {
                value: view.defaultWorkspace,
                // Telegram 的目录本来就一行一个, 行内选中比再开一个下拉更直白;
                // X 沿用标题行的 chip(它的卡上没有别的行内控件可对齐)。
                mode: provider === 'telegram' ? 'row' : 'chip',
                provider,
              })
            : null}
          {/* 存量 global override 的收尾入口。刻意不按 provider 也不按 cs.confirmed 收:
              global scope 是 Telegram 与 X 共用的那一份, 旧设置在绑定确认之前就已经在盘上
              影响解析了 —— 要能看见才谈得上"可管理"。从未改过的设备一次都不会渲染。 */}
          {view.enabled ? (
            <LegacyGlobalDefaultsNotice
              state={legacyGlobalDefaults.state}
              pending={legacyGlobalDefaults.pending}
              onRestore={() => void legacyGlobalDefaults.restore()}
            />
          ) : null}
          {provider === 'telegram' && cs.confirmed ? (
            <div
              key={cs.binding?.bindingId ?? 'telegram-unbound'}
              className="mt-2 flex flex-col gap-5 border-t border-[var(--border-default)] pt-4"
            >
              {view.behaviorAvailable === true ? (
                <>
                  <TelegramBehaviorSettings
                    source="official"
                    bindingId={cs.binding?.bindingId ?? undefined}
                  />
                  <TelegramGroupActivationSettings
                    source="official"
                    bindingId={cs.binding?.bindingId ?? undefined}
                  />
                </>
              ) : null}
            </div>
          ) : null}
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
            label={t('settings.remoteControl.hook.transportStatus', {
              status: t(`settings.remoteControl.hook.status.${hook.status}`),
            })}
          />
        }
        headerAction={
          <Switch
            checked={toggleChecked}
            disabled={slackAuthActionPending}
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
              绑定记录保留, 显式重新授权入口复用开关的启用与浏览器授权流程 */}
          {!multiUi && isBindingFailure && !isNotInstalled ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                  {bindingState === 'denied'
                    ? t('settings.remoteControl.hook.binding.state.denied')
                    : (hook.binding?.message ??
                      t(`settings.remoteControl.hook.binding.state.${bindingState}`))}
                </span>
                <button
                  type="button"
                  onClick={() => handleReauthorize('enable')}
                  disabled={slackAuthActionPending}
                  aria-busy={slackAuthActionPending}
                  className={pillBtn}
                >
                  {t(
                    slackAuthActionPending
                      ? 'settings.remoteControl.hook.binding.reauthorizing'
                      : 'settings.remoteControl.hook.binding.reauthorize',
                  )}
                </button>
              </div>
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
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                  {hook.pendingBind.state === 'denied'
                    ? t('settings.remoteControl.hook.binding.state.denied')
                    : (hook.pendingBind.message ??
                      t(`settings.remoteControl.hook.binding.state.${hook.pendingBind.state}`))}
                </span>
                <button
                  type="button"
                  onClick={() => handleReauthorize('enable')}
                  disabled={slackAuthActionPending}
                  aria-busy={slackAuthActionPending}
                  className={pillBtn}
                >
                  {t(
                    slackAuthActionPending
                      ? 'settings.remoteControl.hook.binding.reauthorizing'
                      : 'settings.remoteControl.hook.binding.reauthorize',
                  )}
                </button>
              </div>
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
                          runSlackAuthAction(
                            () => window.electronAPI.hookControl.rebindTeam(b.teamId),
                            'settings.remoteControl.hook.toast.actionFailed',
                            true,
                          )
                        }
                        disabled={slackAuthActionPending}
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
                      runSlackAuthAction(
                        () => window.electronAPI.hookControl.cancelPendingBind(),
                        'settings.remoteControl.hook.toast.actionFailed',
                      )
                    }
                    disabled={slackAuthActionPending}
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
                        runSlackAuthAction(
                          () => window.electronAPI.hookControl.cancelPendingBind(),
                          'settings.remoteControl.hook.toast.actionFailed',
                        )
                      }
                      disabled={slackAuthActionPending}
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
                      : hook.pendingBind.state === 'denied'
                        ? t('settings.remoteControl.hook.binding.state.denied')
                        : (hook.pendingBind.message ??
                          t(`settings.remoteControl.hook.binding.state.${hook.pendingBind.state}`))}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const pending = hook.pendingBind;
                      // 重试入口由发起意图决定, 不能靠 teamId 猜: add 流的终止态
                      // (denied/expired/failed/already-bound)即使 server 回显 teamId
                      // 也是「新增」失败, 重试必须回 add 流程让授权页可切换 workspace;
                      // 只有发起时就 pin 到 team 的定向重绑才走 rebindTeam。
                      const rebindIntent = pending?.intent === 'rebind';
                      handleReauthorize(
                        rebindIntent ? 'rebind' : 'add',
                        rebindIntent ? pending?.teamId ?? undefined : undefined,
                      );
                    }}
                    disabled={slackAuthActionPending}
                    aria-busy={slackAuthActionPending}
                    className={pillBtn}
                  >
                    {t(
                      slackAuthActionPending
                        ? 'settings.remoteControl.hook.binding.reauthorizing'
                        : 'settings.remoteControl.hook.binding.reauthorize',
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      runSlackAuthAction(
                        () => window.electronAPI.hookControl.cancelPendingBind(),
                        'settings.remoteControl.hook.toast.actionFailed',
                      )
                    }
                    disabled={slackAuthActionPending}
                    className={pillBtn}
                  >
                    {t('settings.remoteControl.hook.multi.dismiss')}
                  </button>
                </div>
              ) : null}
              {hook.serverMultiTeam ? (
                <button
                  type="button"
                  onClick={() =>
                    runSlackAuthAction(
                      () => window.electronAPI.hookControl.addBinding(),
                      'settings.remoteControl.hook.toast.actionFailed',
                      true,
                    )
                  }
                  disabled={slackAuthActionPending}
                  className={`${pillBtn} h-7 gap-1.5 px-3 text-12`}
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
