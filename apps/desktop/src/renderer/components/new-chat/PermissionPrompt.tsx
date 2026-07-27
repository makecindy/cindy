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
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PendingPermission } from '@/lib/makerChatStore';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PermissionPromptProps {
  permission: PendingPermission;
  onRespond: (result: CCAgentPermissionResult) => void;
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

export function PermissionPrompt({ permission, onRespond }: PermissionPromptProps) {
  const { t } = useTranslation();
  const { toolName, input, title, displayName, description, suggestions } = permission;

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

      {/* Action buttons — inline text + kbd badges, right-aligned */}
      <div className="mt-4 flex items-center justify-end gap-2">
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
