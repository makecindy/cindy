import { useTranslation } from 'react-i18next';
import { NoticeExplainPopover } from '@/components/ui/notice-explain-popover';
import { buildChatErrorExplain } from '@/lib/chatErrorExplain';

/**
 * 未完成回复的轻提示行（failedSamplingAttempt）：保留已生成的片段供参考，
 * 并通过「了解原因」浮层解释为何看到半截回复以及后续如何继续。
 */
export function FailedSamplingNotice() {
  const { t } = useTranslation();

  return (
    <div
      className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-13 font-normal leading-[1.384615] text-[var(--text-secondary)]"
      data-testid="message-failed-sampling"
    >
      <span>{t('chat.failedSamplingAttempt')}</span>
      <NoticeExplainPopover
        variant="inline"
        content={buildChatErrorExplain('failedSamplingAttempt', t)}
      />
    </div>
  );
}
