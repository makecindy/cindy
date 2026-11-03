/**
 * 群聊里「已做 8 分钟」这类走动的用时：一个按需走表的 `now`，和与语言无关的用时格式。
 * 只有挂着的走表组件会每秒重绘，时间线其它行不受影响。
 */
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

/** Current time, re-read every `intervalMs` while `enabled`. */
export function useBotGroupNow(enabled: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/** 「12 秒」「8 分钟」「1 小时 5 分」. */
export function formatBotGroupElapsed(ms: number, t: TFunction): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return t('bots.groupChat.elapsed.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('bots.groupChat.elapsed.minutes', { count: minutes });
  return t('bots.groupChat.elapsed.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** A ticking elapsed time since `since`; nothing when the start is unknown. */
export function BotGroupElapsed({ since, className }: { since: number | null; className?: string }) {
  const { t } = useTranslation();
  const now = useBotGroupNow(since !== null);
  if (since === null) return null;
  return <span className={className}>{formatBotGroupElapsed(now - since, t)}</span>;
}
