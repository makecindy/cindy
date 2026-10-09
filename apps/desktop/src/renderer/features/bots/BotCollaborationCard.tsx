import { Megaphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import { BotSessionTaskLink } from './BotSessionTaskLink';

/**
 * 「用时」是说给人听的，不是给日志看的：中文界面里 `8s` 和「用时」并排是两套语言。
 * 单位走 i18n，按秒 / 分 / 时+分 / 天+时+分显示。
 */
export function formatBotCollaborationDuration(
  t: (key: string, options?: Record<string, unknown>) => string,
  startedAt: number,
  endedAt: number,
): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return t('bots.collab.duration.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('bots.collab.duration.minutes', { n: minutes });
  if (seconds >= 86_400) {
    return t('bots.collab.duration.daysHoursMinutes', {
      d: Math.floor(seconds / 86_400),
      h: Math.floor((seconds % 86_400) / 3_600),
      m: minutes % 60,
    });
  }
  return t('bots.collab.duration.hoursMinutes', {
    h: Math.floor(minutes / 60),
    m: minutes % 60,
  });
}

/** 只认结构化标记；形状不对就当没有卡，交回普通文本渲染。 */
export function readBotCollaborationCardData(
  data: Record<string, unknown> | undefined,
): { meta: BotCollaborationMeta; text: string } | null {
  const meta = readBotCollaborationMeta(data);
  if (!meta) return null;
  return { meta, text: typeof data?.text === 'string' ? data.text : '' };
}

interface Props {
  data?: Record<string, unknown>;
  /** 卡片所在的父任务。 */
  sessionId?: string;
}

/**
 * 伙伴历史位置保留原 session 的轻链接；操作与执行状态仍属于原任务。
 */
export function BotSessionTaskCard({ data, sessionId }: Props) {
  const parsed = readBotCollaborationCardData(data);
  if (!parsed || parsed.meta.role !== 'delegation-request') return null;
  return <BotSessionTaskLink card={parsed.meta} sessionId={sessionId} />;
}

/** A quiet persisted trace for a message added to an already-running task. */
export function BotSessionTaskMessageTrace({ data }: Pick<Props, 'data'>) {
  const parsed = readBotCollaborationCardData(data);
  const { t } = useTranslation();
  if (!parsed || parsed.meta.role !== 'interjection') return null;
  return (
    <div className="my-1.5 flex items-start gap-2 text-12 leading-relaxed text-[var(--text-tertiary)]">
      <Megaphone size={13} className="mt-[3px] shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {t('bots.collab.messageSent')}
      </span>
    </div>
  );
}
