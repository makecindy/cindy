/**
 * PermissionPrompt
 * ---------------------------------------------------------------------------
 * F-PERM-2: Permission request card that replaces ChatInput when the SDK is
 * waiting for user authorization to execute a tool.
 *
 * Layout:
 *   title  → description → code block (tool input) → action buttons
 *
 * Keyboard shortcuts (registered on mount, removed on unmount):
 *   Enter       → Allow once
 *   Ctrl+Enter  → Always allow for session
 *   Esc         → Deny
 *   Shift+Tab   → cycle permission mode (only with `modeSwitch`; combo is
 *                 user-rebindable via the `cycle-permission-mode` registry;
 *                 see the note below — cycling settles the pending request)
 *
 * `modeSwitch` (optional): while this card is up, ChatInput is unmounted, so the
 * composer's permission chip *and* its Shift+Tab cycling both disappear — the
 * user gets stuck answering prompts one by one with no way to reach "auto
 * approve". Passing `modeSwitch` puts that same chip on the card. Omit the prop
 * and this component renders exactly as before.
 *
 * IMPORTANT — switching modes DOES settle the pending request. This component
 * never calls `onRespond` itself, but maker-core settles every in-flight
 * interaction on a mode change (`dismissAllPending` in the claude-code / codex
 * agents): loosening to Auto / Full access resolves it as **allow**, any other
 * target resolves it as **deny**. That is pre-existing behaviour shared with the
 * composer's chip, not something this card introduces — but the card puts the
 * control right next to Allow/Deny, so the copy must not imply "settings only".
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PendingPermission } from '@/lib/makerChatStore';
import { getAppShortcutCombos } from '@/lib/appShortcutStore';
import { getNextPermissionMode } from '@/lib/permissionModeCycle';
import type { PermissionMode } from '@/lib/userPreferences.types';
import type { PermissionModeDescriptor } from '@/hooks/useAgentCapabilities';
import { matchesKeyboardEvent } from '../../../shared/appShortcuts';
import { PermissionSelector } from './PermissionSelector';
import {
  acquirePermissionShortcutOwnership,
  getPermissionShortcutOwner,
  subscribePermissionShortcutOwner,
} from './permissionShortcutOwner';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PermissionPromptModeSwitch {
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  vendorKey: 'cc' | 'codex';
  /** device-link 远程会话所属被控端 id;本地会话留空。 */
  deviceId?: string;
  /** Shift+Tab 轮切候选 —— 与下拉同一份 capabilities.permissionModes,顺序一致。 */
  cycleOptions: readonly PermissionModeDescriptor[];
  /** 远程断链等只读态:chip 置灰,轮切快捷键一并停用(否则给出必失败的假入口)。 */
  disabled?: boolean;
}

interface PermissionPromptProps {
  permission: PendingPermission;
  onRespond: (result: CCAgentPermissionResult) => void;
  modeSwitch?: PermissionPromptModeSwitch;
  /**
   * 本卡片是否在用户眼前。false = 不注册任何 window 级快捷键(卡片照常渲染)。
   *
   * 快捷键挂在 window 上,而 CCAgentSessionView 是**多实例**的:Orca 协同下 lead 与
   * focused worker 各挂一个,右栏折叠时 body 也仍然挂载。两边同时有 pending 时,
   * 不 gate 的话一次 Enter / Esc / Shift+Tab 会同时落到看不见的那张卡上 —— 用户
   * 没看见的工具请求被放行或拒绝(Shift+Tab 尤其隐蔽:切档会连带 dismiss pending)。
   *
   * 默认 true:不传的调用方(workdir-browse 等单实例场景)行为不变。
   */
  shortcutsActive?: boolean;
}

// ---------------------------------------------------------------------------
// Tool input → display text
// ---------------------------------------------------------------------------

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2);
    case 'Read':
    case 'Edit':
    case 'Write':
      return typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2);
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : JSON.stringify(input, null, 2);
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : JSON.stringify(input, null, 2);
    default: {
      const text = JSON.stringify(input, null, 2);
      return text.length > 500 ? text.slice(0, 500) + '...' : text;
    }
  }
}

/**
 * 这些容器里的按键不归卡片管 —— 卡片的 Enter/Esc/Shift+Tab 是挂在 window 上的,
 * 不挡就会劫持掉浮层自己的键盘语义:
 * - `dialog` / `alertdialog`:切 Full access 时弹的二次确认框(卡片仍挂载),
 *   不挡则确认框上的 Enter 顺带 Allow once、Esc 顺带 Deny。
 * - `listbox` / `data-morph-side`:权限档 chip 的 MorphPopover 弹层。它 portal 到
 *   body,不在卡片 DOM 子树内,只能靠 role / 属性认。不挡则键盘用户在菜单里按 Esc
 *   关菜单会顺带 Deny 掉请求、按 Enter 选档会先被 Allow once 截胡。
 * - `aria-haspopup`:chip trigger 自身。Tab 到它按 Enter 的语义是"打开菜单",
 *   不是"批准这条请求"——不挡则菜单根本打不开,请求却被批了。
 */
const SHORTCUT_OPT_OUT_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[data-morph-side]',
  '[aria-haspopup]',
].join(', ');

/**
 * 焦点落在普通可交互控件上时,卡片的全局快捷键一律让位给原生键盘语义。
 *
 * 键盘用户 Tab 到 Deny / Always allow / Allow once 之后:Shift+Tab 是"回上一个控件",
 * Enter 是"按下当前这颗按钮" —— 都不该被 window handler 抢走。抢走的后果是用户
 * 想 Deny 却触发了 Allow once、想挪焦点却切了档(并连带结掉请求)。
 *
 * 焦点在 body / 卡片容器上(用户没在做焦点导航)时才是快捷键的主场。
 */
function isInteractiveTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return !!target.closest?.(
    'button, a[href], input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
  );
}

function filterSessionScopedSuggestions(suggestions?: unknown[]): unknown[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((suggestion) =>
    !!suggestion &&
    typeof suggestion === 'object' &&
    !Array.isArray(suggestion) &&
    (suggestion as Record<string, unknown>).destination === 'session'
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PermissionPrompt({
  permission,
  onRespond,
  modeSwitch,
  shortcutsActive = true,
}: PermissionPromptProps) {
  const { t } = useTranslation();
  const { toolName, input, title, displayName, description, suggestions } = permission;

  // keydown handler 只在动作 handler 变化时重注册;modeSwitch 每次渲染都是新对象,
  // 走 ref 取最新值,避免 window listener 每帧摘挂(同 ChatInput 的 ref 桥接约定)。
  const modeSwitchRef = useRef(modeSwitch);
  modeSwitchRef.current = modeSwitch;

  // 键盘所有权:同时可见的多张卡片(Orca 的 lead + worker)里只能有一张吃快捷键,
  // 否则一次按键会把两个会话的 pending 一起结掉。见 permissionShortcutOwner 顶注。
  const ownerTokenRef = useRef<symbol | null>(null);
  ownerTokenRef.current ??= Symbol('permission-prompt-shortcuts');
  const ownerToken = ownerTokenRef.current;
  useEffect(() => {
    if (!shortcutsActive) return;
    return acquirePermissionShortcutOwnership(ownerToken);
  }, [ownerToken, shortcutsActive]);
  const currentOwner = useSyncExternalStore(
    subscribePermissionShortcutOwner,
    getPermissionShortcutOwner,
    getPermissionShortcutOwner,
  );
  const ownsShortcuts = shortcutsActive && currentOwner === ownerToken;

  const displayTitle = displayName
    ? t('agentIsland.native.permissionPromptTitleWithTool', { toolName: displayName })
    : title || t('agentIsland.native.permissionPromptTitleWithTool', { toolName });
  const codeContent = formatToolInput(toolName, input);
  const sessionSuggestions = useMemo(() => filterSessionScopedSuggestions(suggestions), [suggestions]);
  const canAlwaysAllowForSession = sessionSuggestions.length > 0;

  // ── Action handlers ──

  const handleAllowOnce = useCallback(() => {
    onRespond({
      behavior: 'allow',
    });
  }, [onRespond]);

  const handleAlwaysAllow = useCallback(() => {
    if (!canAlwaysAllowForSession) {
      handleAllowOnce();
      return;
    }
    onRespond({
      behavior: 'allow',
      updatedPermissions: sessionSuggestions,
      decisionClassification: 'user_permanent',
    });
  }, [canAlwaysAllowForSession, handleAllowOnce, onRespond, sessionSuggestions]);

  const handleDeny = useCallback(() => {
    onRespond({
      behavior: 'deny',
      message: 'User denied',
      decisionClassification: 'user_reject',
    });
  }, [onRespond]);

  // ── Keyboard shortcuts ──

  useEffect(() => {
    // 看不见的、以及同屏多卡时没拿到所有权的实例,一律不参与键盘。
    if (!ownsShortcuts) return;
    const handler = (e: KeyboardEvent) => {
      // IME 组合期间的 Enter(确认候选词)不算快捷键;焦点在可编辑元素上时
      // (侧栏重命名/查找栏等)也不劫持按键,避免把输入操作误判成授权决定。
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      // 浮层(确认框 / 档位菜单 / chip trigger)里的按键一律不穿透到卡片,
      // 见 SHORTCUT_OPT_OUT_SELECTOR 顶注。这些浮层聚焦的都是普通 <button>,
      // 不在上面的排除列表里,且都不 stopPropagation。
      // closest 走可选调用:事件直接派发到 window / document 时 target 不是 Element。
      if (target?.closest?.(SHORTCUT_OPT_OUT_SELECTOR)) return;
      // 焦点在普通按钮/链接上 = 用户正在用键盘导航,全局快捷键让位给原生语义。
      if (isInteractiveTarget(target)) return;
      // cycle-permission-mode (registry 默认 Shift+Tab, 用户可改绑) —— 补齐卡片期间
      // 失效的键盘路径: ChatInput 不挂载时它的 TipTap handler 一起没了。
      // 轮切与点 chip 走同一条切档路径, 因此同样会由 maker-core 结掉当前 pending
      // (放宽→allow, 其它→deny, 见文件顶注) —— 这里只是不自己 onRespond。
      // 可用模式不足 2 个时不消费, Shift+Tab 保持原生焦点导航。
      const cycle = modeSwitchRef.current;
      if (
        cycle &&
        !cycle.disabled &&
        !e.repeat &&
        getAppShortcutCombos('cycle-permission-mode').some((combo) =>
          matchesKeyboardEvent(e, combo),
        )
      ) {
        const next = getNextPermissionMode(cycle.permissionMode, cycle.cycleOptions);
        if (next) {
          e.preventDefault();
          cycle.onPermissionModeChange(next);
          return;
        }
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleAlwaysAllow();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleAllowOnce();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleDeny();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleAllowOnce, handleAlwaysAllow, handleDeny, ownsShortcuts]);

  // ── Render ──

  return (
    <div
      className={cn(
        'w-full max-w-[914px] rounded-[12px] border p-4',
        'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
      )}
    >
      {/* Title */}
      <p className="text-15 font-semibold leading-tight text-[var(--chat-input-text)]">
        {displayTitle}
      </p>

      {/* Description */}
      {description && (
        <p className="mt-1.5 text-13 font-normal leading-tight text-[var(--status-bar-meta)]">
          {description}
        </p>
      )}

      {/* Code block */}
      <div
        className={cn(
          'mt-3 max-h-[120px] overflow-auto rounded-[8px] border px-3.5 py-2.5',
          'border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]',
          'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-relaxed text-[var(--chat-input-text)]',
        )}
      >
        <pre className="whitespace-pre-wrap break-all">{codeContent}</pre>
      </div>

      {/* Action buttons — inline text + kbd badges, right-aligned.
          有 modeSwitch 时左端多一枚权限档 chip(mr-auto 顶开),窄宽(doc rail portal)
          下允许 chip 与动作组换行分层;不传时排布与换行行为与改造前逐字一致。 */}
      <div
        className={cn(
          'mt-4 flex items-center justify-end gap-2',
          modeSwitch && 'flex-wrap',
        )}
      >
        {modeSwitch && (
          // 切档改的是会话后续行为,但 maker-core 会连带结掉当前这条 pending
          // (放宽→allow,其它→deny,见文件顶注)。本组件不自己 onRespond。
          <div className="mr-auto flex min-w-0 items-center">
            <PermissionSelector
              permissionMode={modeSwitch.permissionMode}
              onPermissionModeChange={modeSwitch.onPermissionModeChange}
              vendorKey={modeSwitch.vendorKey}
              deviceId={modeSwitch.deviceId}
              disabled={modeSwitch.disabled}
            />
          </div>
        )}

        {/* Deny */}
        <button
          type="button"
          onClick={handleDeny}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)] bg-transparent',
            'text-13 font-medium text-[var(--chat-input-text)]',
            'transition-colors hover:bg-[var(--perm-code-bg)]',
          )}
        >
          <span>{t('agentIsland.native.deny')}</span>
          <kbd className="rounded-[4px] border border-[var(--chat-input-border)] bg-[var(--perm-code-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--status-bar-meta)]">
            Esc
          </kbd>
        </button>

        {canAlwaysAllowForSession && (
          <button
            type="button"
            onClick={handleAlwaysAllow}
            className={cn(
              'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
              'border-[var(--chat-input-border)] bg-transparent',
              'text-13 font-medium text-[var(--chat-input-text)]',
              'transition-colors hover:bg-[var(--perm-code-bg)]',
            )}
          >
            <span>{t('agentIsland.native.alwaysAllowForSession')}</span>
            <kbd className="rounded-[4px] border border-[var(--chat-input-border)] bg-[var(--perm-code-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--status-bar-meta)]">
              Ctrl
            </kbd>
            <kbd className="-ml-1 rounded-[4px] border border-[var(--chat-input-border)] bg-[var(--perm-code-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--status-bar-meta)]">
              Enter
            </kbd>
          </button>
        )}

        {/* Allow once (primary) */}
        <button
          type="button"
          onClick={handleAllowOnce}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)]',
            'bg-[var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)]',
            'text-13 font-medium',
            'transition-colors hover:opacity-90',
          )}
        >
          <span>{t('agentIsland.native.allowOnce')}</span>
          <kbd className="rounded-[4px] border border-[var(--perm-allow-kbd-border)] bg-[var(--perm-allow-kbd-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--perm-allow-btn-text)] opacity-70">
            Enter
          </kbd>
        </button>
      </div>
    </div>
  );
}
