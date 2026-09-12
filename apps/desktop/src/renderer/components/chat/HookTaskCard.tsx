/**
 * HookTaskCard
 * ---------------------------------------------------------------------------
 * Hook(IM 渠道)消息的 Cindy 署名任务卡片 —— 左对齐渲染, 替代右对齐用户气泡。
 * 视觉语义采用左对齐的 "Hook Message — Tina Task Card"。
 *
 * 显示与 prompt 分离: 卡片正文渲染 source.userText(用户 @ 的干净原文),
 * 本条附带的引用消息与群聊背景分组折叠; prompt 中的技术指引不显示。
 */

import { useId, useState } from 'react';
import { ChevronRight, MessageSquare, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import SlackIcon from './SlackIcon';
import XIcon from './XIcon';
import { isImMessageCount, type ImMessageSource } from '../../../shared/imMessageSource';
import { mayExceedVisualLineThreshold, useUserMessageAutoCollapse } from './userMessageCollapse';

type ThreadContextEntry = NonNullable<ImMessageSource['threadContext']>[number];

interface HookTaskCardProps {
  im: string;
  /** 用户 @ bot 的干净原文(卡片正文)。 */
  userText: string;
  collapseUserText?: boolean;
  threadContext?: ThreadContextEntry[];
  /** 本条消息保存的群聊快照,不是当前群历史;技术指引已在投影层排除。 */
  groupContext?: string | null;
  replyContext?: string;
  groupMessageCount?: number;
  replyMessageCount?: number;
}

function ImIcon({ im }: { im: string }) {
  switch (im) {
    case 'slack':
      return <SlackIcon className="w-[14px] h-[14px] shrink-0 text-[var(--text-primary)]" />;
    case 'telegram':
      return <Send size={14} strokeWidth={1.75} className="shrink-0 text-[var(--text-primary)]" />;
    case 'x':
      return <XIcon className="w-[14px] h-[14px] shrink-0 text-[var(--text-primary)]" />;
    default:
      return (
        <MessageSquare
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-[var(--text-primary)]"
        />
      );
  }
}

function imLabel(im: string): string {
  switch (im) {
    case 'slack':
      return 'Slack';
    case 'telegram':
      return 'Telegram';
    case 'x':
      return 'X';
    case 'feishu':
      return 'Feishu';
    case 'lark':
      return 'Lark';
    default:
      return im;
  }
}

export default function HookTaskCard({
  im,
  userText,
  collapseUserText = false,
  threadContext,
  groupContext,
  replyContext,
  groupMessageCount,
  replyMessageCount,
}: HookTaskCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const measureBody = collapseUserText && mayExceedVisualLineThreshold(userText);
  const { mirrorRef, shouldCollapse } = useUserMessageAutoCollapse(userText, measureBody);
  const contextId = useId();
  const entries = threadContext ?? [];
  const hasGroupContext = typeof groupContext === 'string' && Boolean(groupContext.trim());
  const hasReplyContext = typeof replyContext === 'string' && Boolean(replyContext.trim());
  const replyCount = !hasReplyContext
    ? entries.length
    : isImMessageCount(replyMessageCount)
      ? replyMessageCount + entries.length
      : undefined;
  const groupCount = !hasGroupContext
    ? 0
    : isImMessageCount(groupMessageCount)
      ? groupMessageCount
      : undefined;
  const totalCount =
    replyCount !== undefined && groupCount !== undefined ? replyCount + groupCount : undefined;

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
        <span className="text-13 font-semibold text-[var(--text-primary)]">
          {t('chat.threadContext.cindyFrom', { platform: imLabel(im) })}
        </span>
      </div>

      {/* Body: 用户实际提问 */}
      <div className="px-[14px] pb-[12px] flex flex-col gap-2">
        <div className="relative text-14 leading-[1.6] text-[var(--text-primary)] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {measureBody && (
            <div
              ref={mirrorRef}
              aria-hidden="true"
              className="invisible absolute inset-x-0 top-0 max-h-0 overflow-hidden"
            >
              {userText}
            </div>
          )}
          <div className={cn(shouldCollapse && !bodyExpanded && 'line-clamp-10')}>{userText}</div>
          {shouldCollapse && (
            <button
              type="button"
              aria-expanded={bodyExpanded}
              onClick={() => setBodyExpanded((value) => !value)}
              className="mt-2 text-12 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
            >
              {t(
                bodyExpanded
                  ? 'chat.userMessage.collapseLongMessage'
                  : 'chat.userMessage.expandLongMessage',
              )}
            </button>
          )}
        </div>

        {/* 一条消息的附带上下文共用一个折叠入口;展开后按来源分组。 */}
        {(entries.length > 0 || hasReplyContext || hasGroupContext) && (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={expanded ? contextId : undefined}
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 w-fit cursor-pointer',
                'text-12 font-medium text-[var(--text-tertiary)]',
                'hover:text-[var(--text-secondary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2',
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
              <span>
                {totalCount !== undefined
                  ? t('chat.threadContext.attachedContextCount', { count: totalCount })
                  : t('chat.threadContext.attachedContext')}
              </span>
            </button>
            {/* 父容器 gap-2 与 -mt-2 恒等相消,间距改由内层 pt-2 承担
                (在 overflow-hidden 里随高度动画),挂载/卸载瞬间零跳变。 */}
            <Collapse open={expanded} id={contextId} className="-mt-2" innerClassName="pt-2">
              <div className="flex flex-col gap-3 pl-[18px] text-12 leading-[1.5] text-[var(--text-secondary)] break-words">
                {(entries.length > 0 || hasReplyContext) && (
                  <section aria-labelledby={`${contextId}-replies`} className="flex flex-col gap-1">
                    <h4
                      id={`${contextId}-replies`}
                      className="font-medium text-[var(--text-tertiary)]"
                    >
                      {replyCount !== undefined
                        ? t('chat.threadContext.referencedMessages', { count: replyCount })
                        : t('chat.threadContext.referencedContext')}
                    </h4>
                    {hasReplyContext && <div className="whitespace-pre-wrap">{replyContext}</div>}
                    {entries.map((entry, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 消息内容不可变,index 稳定。
                      <div key={i} className="whitespace-pre-wrap">
                        <span className="font-semibold">[{entry.author}]</span> {entry.text}
                      </div>
                    ))}
                  </section>
                )}
                {hasGroupContext && (
                  <section aria-labelledby={`${contextId}-group`} className="flex flex-col gap-1">
                    <h4
                      id={`${contextId}-group`}
                      className="font-medium text-[var(--text-tertiary)]"
                    >
                      {groupCount !== undefined
                        ? t('chat.threadContext.groupBackgroundCount', { count: groupCount })
                        : t('chat.threadContext.groupBackground')}
                    </h4>
                    <div className="whitespace-pre-wrap">{groupContext}</div>
                  </section>
                )}
              </div>
            </Collapse>
          </>
        )}
      </div>
    </div>
  );
}
