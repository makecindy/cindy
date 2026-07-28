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

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PendingPermission } from '@/lib/makerChatStore';
import { getAppShortcutCombos } from '@/lib/appShortcutStore';
import { getNextPermissionMode } from '@/lib/permissionModeCycle';
import type { PermissionMode } from '@/lib/userPreferences.types';
import type { PermissionModeDescriptor } from '@/hooks/useAgentCapabilities';
import { matchesKeyboardEvent } from '../../../shared/appShortcuts';
import { PermissionSelector } from './PermissionSelector';

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

export function PermissionPrompt({ permission, onRespond, modeSwitch }: PermissionPromptProps) {
  const { t } = useTranslation();
  const { toolName, input, title, displayName, description, suggestions } = permission;

  // keydown handler 只在动作 handler 变化时重注册;modeSwitch 每次渲染都是新对象,
  // 走 ref 取最新值,避免 window listener 每帧摘挂(同 ChatInput 的 ref 桥接约定)。
  const modeSwitchRef = useRef(modeSwitch);
  modeSwitchRef.current = modeSwitch;

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
    const handler = (e: KeyboardEvent) => {
      // IME 组合期间的 Enter(确认候选词)不算快捷键;焦点在可编辑元素上时
      // (侧栏重命名/查找栏等)也不劫持按键,避免把输入操作误判成授权决定。
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      // 模态里的按键一律不穿透到卡片:切 Full access 会在卡片仍挂载时弹二次确认,
      // 而确认框聚焦的是普通 <button>(不在上面的排除列表里)且不 stopPropagation ——
      // 不挡的话在确认框上按 Enter 会顺带 Allow once、按 Esc 会顺带 Deny,
      // 等于用键盘替用户回答了这条工具请求。
      // closest 走可选调用:事件直接派发到 window / document 时 target 不是 Element。
      if (target?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
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
  }, [handleAllowOnce, handleAlwaysAllow, handleDeny]);

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
