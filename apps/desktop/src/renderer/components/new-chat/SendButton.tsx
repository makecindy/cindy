import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface SendButtonProps {
  disabled: boolean;
  onClick: () => void;
  /** When true, renders the streaming Stop variant. */
  isStreaming?: boolean;
  /** Highlighted while voice long-press is hovering over this button as a release target. */
  highlighted?: boolean;
  /** Override for the accessible action name when Send visually means Queue. */
  ariaLabel?: string;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
}

function CreateAgentSendIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="currentColor"
    >
      <path d="M2.6 3.35a1 1 0 0 1 1.08-.13l17.2 8a.88.88 0 0 1 0 1.56l-17.2 8A1 1 0 0 1 2.3 19.6l2.04-6.44L13 12 4.34 10.84 2.3 4.4a1 1 0 0 1 .3-1.05Z" />
    </svg>
  );
}

/**
 * Send / Stop button
 *
 * Send (idle): 28×28 圆形（9999）, bg #262626/#fff, arrow-up icon 白/黑
 * Stop (streaming):复用 Send 壳样式,仅把内容换成 10×10 圆角 1.5 的停止方块
 */
export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(function SendButton(
  { disabled, onClick, isStreaming = false, highlighted = false, ariaLabel, visualVariant = 'default' },
  ref,
) {
  const { t } = useTranslation();
  const isCreateAgentVariant = visualVariant === 'create-agent';
  return (
    <button
      ref={ref}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // transform 进过渡集:承载 active 按压缩放(DESIGN.md §14.4 按压原型)。
        'flex shrink-0 items-center justify-center rounded-full transition-[color,background-color,transform]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chat-input-bg)]',
        !disabled && 'active:scale-[0.98]',
        // create-agent(新建对话框)send 与会话内共用 send-btn-* token,三态(hover/pressed/disabled)一致;
        // 仅尺寸随所在工具条密度不同(新建对话框行高 30px,会话内 28px)。
        isCreateAgentVariant ? 'h-[30px] w-[30px]' : 'h-7 w-7',
        'bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)]',
        !disabled && 'hover:bg-[var(--send-btn-hover-bg)] active:bg-[var(--send-btn-pressed-bg)]',
        highlighted && !disabled && !isStreaming && 'opacity-85',
        disabled && !isStreaming && 'cursor-not-allowed opacity-40',
      )}
      aria-label={ariaLabel ?? (isStreaming ? t('newChat.sendButton.stop') : t('newChat.sendButton.send'))}
    >
      {/* send / stop 两态图标叠放同格交叉淡切(150ms,opacity+scale,
          compositor-only),替代条件渲染的瞬间硬换。 */}
      <span className="relative grid h-3.5 w-3.5 place-items-center" aria-hidden>
        <span
          className={cn(
            'col-start-1 row-start-1 flex items-center justify-center',
            'transition-[opacity,transform] duration-[var(--motion-fast,150ms)] ease-[var(--motion-ease-out)]',
            isStreaming ? 'scale-75 opacity-0' : 'scale-100 opacity-100',
          )}
        >
          <CreateAgentSendIcon />
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 block h-[10px] w-[10px] rounded-[1.5px] bg-[var(--send-btn-icon)]',
            'transition-[opacity,transform] duration-[var(--motion-fast,150ms)] ease-[var(--motion-ease-out)]',
            isStreaming ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
          )}
        />
      </span>
    </button>
  );
});
