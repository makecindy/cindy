/**
 * 正在发言的伙伴此刻写到哪了：群专线（或分工 Session）在这台电脑上跑时，它的流式正文已经
 * 在 makerChatStore 里（maker 事件按 sessionId 写入，不需要读历史），这里只取最后几行，
 * 让群里像打字一样逐字出来。专线不在本机运行（服务器群的别的电脑在执行）时没有内容，
 * 什么也不显示；正文可能还会变成静默标记 NO_REPLY，在那之前不显示。
 */
import { useCallback, useSyncExternalStore } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';
import { cn } from '@/lib/utils';
import { isBotGroupNoReplyPrefix } from '../../../shared/botGroupChat';

/** The last `lines` non-empty lines of the streaming reply, or ''. */
export function botGroupLiveTail(text: string, lines: number): string {
  if (isBotGroupNoReplyPrefix(text)) return '';
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-lines).join('\n');
}

export function BotGroupLivePreview({ sessionId, lines = 2, className }: { sessionId: string; lines?: number; className?: string }) {
  const subscribe = useCallback((listener: () => void) => makerChatStore.subscribe(sessionId, listener), [sessionId]);
  // A string snapshot: unrelated store updates of this Session do not re-render.
  const read = useCallback(() => botGroupLiveTail(makerChatStore.getSnapshot(sessionId).streamingText ?? '', lines), [sessionId, lines]);
  const tail = useSyncExternalStore(subscribe, read, read);
  if (!tail) return null;
  return (
    <div data-testid="bot-group-live-preview" aria-hidden className={cn('flex min-w-0 flex-col text-13 leading-5 text-[var(--text-secondary)]', className)}>
      {tail.split('\n').map((line, index) => (
        <span key={index} className="min-w-0 truncate">{line}</span>
      ))}
    </div>
  );
}
