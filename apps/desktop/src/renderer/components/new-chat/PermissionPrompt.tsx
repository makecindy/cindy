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
import { Tip } from '@/components/ui/tooltip';
import type { PendingPermission } from '@/lib/makerChatStore';
import { describeSessionPermissionScope } from '@/lib/permissionSuggestionScope';

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

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// harness 无关:CC 工具名首字母大写 + file_path;pi 内置工具名小写 + path/command。
// 按语义分组(命令 / 文件 / 模式)归一化,任一命名命中就抽出清爽正文,否则回退 JSON。
export function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  const fallback = () => {
    const text = JSON.stringify(input, null, 2);
    return text.length > 500 ? text.slice(0, 500) + '...' : text;
  };
  if (name === 'bash') {
    return firstString(input, ['command']) ?? fallback();
  }
  if (name === 'read' || name === 'edit' || name === 'write') {
    return firstString(input, ['file_path', 'path', 'notebook_path']) ?? fallback();
  }
  if (name === 'glob' || name === 'grep' || name === 'find' || name === 'ls') {
    return firstString(input, ['pattern', 'path', 'query']) ?? fallback();
  }
  return fallback();
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
  // 这个按钮加的是 agent 给的一条具体规则(Bash 多为 `curl:*` 这类前缀模式),
  // 范围远小于「总是允许」的字面。把范围写到按钮上,别让用户猜。
  // 描述不全时返回 null(见该函数顶注:点击会转发**全部** suggestions,文案漏项就是说谎),
  // 此时退回不声称范围的原文案。分隔符按当前语言取 —— 顿号不能漏进英文句子。
  const scopeLabels = useMemo(
    () => describeSessionPermissionScope(sessionSuggestions),
    [sessionSuggestions],
  );
  const allowScope = scopeLabels?.join(t('newChat.permissionPrompt.ruleSeparator')) ?? null;

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

      {/* Action buttons — inline text + kbd badges, right-aligned.
          flex-wrap:带范围的「本对话都允许 …」按钮会比原来长,窄宽(doc rail portal)
          下允许整行折行,而不是把 Deny / Allow once 挤出容器。 */}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
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
          // 有具体规则就把范围写进按钮(`本对话都允许 Bash(curl:*)`),没有则退回原文案。
          // tooltip 补两件按钮里放不下的事:完整规则(长命令会被 truncate)、以及
          // 「作用于整个对话」——用户容易把「本对话」读成「这一次来回」。
          // 列不出范围时(Codex 的会话级放行只给一个不带规则的标记,范围由 app-server 定)
          // 换成只讲时效的说法:一条都没列出还说「只限这里列出的范围」就是虚假安心。
          <Tip
            text={
              allowScope
                ? `${allowScope}\n${t('newChat.permissionPrompt.alwaysAllowScopedHint')}`
                : t('newChat.permissionPrompt.alwaysAllowSessionHint')
            }
            side="top"
            contentClassName="max-w-[320px] whitespace-pre-line break-all text-left"
          >
            <button
              type="button"
              onClick={handleAlwaysAllow}
              className={cn(
                // max-w:规则可能很长(完整命令串),截断后完整内容看 tooltip。
                'flex min-w-0 max-w-[460px] items-center gap-2 rounded-[8px] border px-3 py-[7px]',
                'border-[var(--chat-input-border)] bg-transparent',
                'text-13 font-medium text-[var(--chat-input-text)]',
                'transition-colors hover:bg-[var(--perm-code-bg)]',
              )}
            >
              <span className="min-w-0 truncate">
                {allowScope
                  ? t('newChat.permissionPrompt.alwaysAllowScoped', { scope: allowScope })
                  : t('agentIsland.native.alwaysAllowForSession')}
              </span>
              <kbd className="shrink-0 rounded-[4px] border border-[var(--chat-input-border)] bg-[var(--perm-code-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--status-bar-meta)]">
                Ctrl
              </kbd>
              <kbd className="-ml-1 shrink-0 rounded-[4px] border border-[var(--chat-input-border)] bg-[var(--perm-code-bg)] px-1.5 py-[1px] text-11 font-normal text-[var(--status-bar-meta)]">
                Enter
              </kbd>
            </button>
          </Tip>
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
