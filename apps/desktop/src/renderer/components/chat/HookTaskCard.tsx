/**
 * HookTaskCard
 * ---------------------------------------------------------------------------
 * Hook(IM 渠道)消息的 Cindy 署名任务卡片 —— 左对齐渲染, 替代右对齐用户气泡。
 * 视觉语义采用左对齐的 "Hook Message — Tina Task Card"。
 *
 * 显示与 prompt 分离: 卡片正文渲染 source.userText(用户 @ 的干净原文),
 * thread 上下文折叠可展开; 发给 agent 的完整工程化 prompt(含指引文本)
 * 永不显示。
 */

import { useState } from 'react';
import { ChevronRight, MessageSquare, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import SlackIcon from './SlackIcon';

interface ThreadContextEntry {
  author: string;
  text: string;
  isBot?: boolean;
}

interface HookTaskCardProps {
  im: string;
  /** 用户 @ bot 的干净原文(卡片正文)。 */
  userText: string;
  threadContext?: ThreadContextEntry[];
}

function ImIcon({ im }: { im: string }) {
  switch (im) {
    case 'slack':
      return <SlackIcon className="w-[14px] h-[14px] shrink-0 text-[var(--text-primary)]" />;
    case 'telegram':
      return <Send size={14} strokeWidth={1.75} className="shrink-0 text-[var(--text-primary)]" />;
    default:
      return <MessageSquare size={14} strokeWidth={1.75} className="shrink-0 text-[var(--text-primary)]" />;
  }
}

function imLabel(im: string): string {
  switch (im) {
    case 'slack':
      return 'Slack';
    case 'telegram':
      return 'Telegram';
    case 'feishu':
      return 'Feishu';
    default:
      return im;
  }
}

export default function HookTaskCard({ im, userText, threadContext }: HookTaskCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const entries = threadContext ?? [];

  return (
    <div
      className={cn(
        'w-full rounded-[12px] overflow-hidden',
        'bg-[var(--msg-tool-card-bg)]',
        'border border-[var(--msg-tool-card-border)]',
      )}
    >
      {/* Header: IM 图标 + Cindy 署名 */}
      <div className="flex items-center gap-2 px-[14px] pt-[10px] pb-[6px]">
        <ImIcon im={im} />
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t('chat.threadContext.cindyFrom', { platform: imLabel(im) })}
        </span>
      </div>

      {/* Body: 用户实际提问 */}
      <div className="px-[14px] pb-[12px] flex flex-col gap-2">
        <div className="text-[14px] leading-[1.6] text-[var(--text-primary)] whitespace-pre-wrap break-words">
          {userText}
        </div>

        {/* Thread 上下文: 折叠按钮 + 展开列表 */}
        {entries.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 w-fit cursor-pointer',
                'text-[12px] font-medium text-[var(--text-tertiary)]',
                'hover:text-[var(--text-secondary)] transition-colors focus:outline-none',
              )}
            >
              <ChevronRight
                size={12}
                className={cn(
                  'shrink-0',
                  'transition-transform duration-[var(--motion-fast,150ms)]',
                  expanded && 'rotate-90',
                )}
              />
              <span>{t('chat.threadContext.viewThread', { count: entries.length })}</span>
            </button>
            {/* 父容器 gap-2 与 -mt-2 恒等相消,间距改由内层 pt-2 承担
                (在 overflow-hidden 里随高度动画),挂载/卸载瞬间零跳变。 */}
            <Collapse open={expanded} className="-mt-2" innerClassName="pt-2">
              <div className="flex flex-col gap-0.5 pl-[18px]">
                {entries.map((entry, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 消息内容不可变,index 稳定。
                  <div key={i} className="text-[12px] leading-[1.5] text-[var(--text-tertiary)] break-words">
                    <span className="font-semibold">[{entry.author}]</span> {entry.text}
                  </div>
                ))}
              </div>
            </Collapse>
          </>
        )}
      </div>
    </div>
  );
}
