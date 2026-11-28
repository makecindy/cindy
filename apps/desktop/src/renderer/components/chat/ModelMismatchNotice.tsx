import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NoticeExplainPopover } from '@/components/ui/notice-explain-popover';
import { formatModelShortLabel } from '@/lib/modelShortLabel';
import type { ModelMismatchInfo } from '../../../shared/modelMismatch';

/**
 * Assistant 回复下方常显的模型改派提示行：明确指出由外部模型供应商将本轮改派给
 * 另一个模型，并提供「了解原因」浮层说明成因与处理建议，避免用户误以为是 Cindy 改动。
 */
export function ModelMismatchNotice({ mismatch }: { mismatch: ModelMismatchInfo }) {
  const { t } = useTranslation();
  const actual = formatModelShortLabel(mismatch.actual) || mismatch.actual;
  const selected = formatModelShortLabel(mismatch.selected) || mismatch.selected;
  const provider = mismatch.providerName?.trim();

  const noticeText = provider
    ? t('chat.modelMismatch.noticeWithProvider', { provider, actual, selected })
    : t('chat.modelMismatch.notice', { actual, selected });

  const summaryText = provider
    ? t('chat.modelMismatch.infoSummaryWithProvider', { provider, selected, actual })
    : t('chat.modelMismatch.infoSummary', { selected, actual });

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-11 text-[var(--text-tertiary)]"
      data-testid="message-model-mismatch"
    >
      <TriangleAlert size={11} className="shrink-0 text-[var(--warning-fg)]" aria-hidden />
      <span>{noticeText}</span>
      <NoticeExplainPopover
        variant="inline"
        content={{
          title: t('chat.modelMismatch.infoTitle'),
          summary: summaryText,
          causesTitle: t('chat.modelMismatch.infoCausesTitle'),
          causes: [
            t('chat.modelMismatch.infoCausePolicy'),
            t('chat.modelMismatch.infoCauseLoad'),
            t('chat.modelMismatch.infoCauseGateway'),
          ],
          actionsTitle: t('chat.modelMismatch.infoActionsTitle'),
          actions: [
            t('chat.modelMismatch.infoActionContinue', { selected }),
            t('chat.modelMismatch.infoActionRetry'),
            t('chat.modelMismatch.infoActionCheckProvider'),
          ],
        }}
      />
    </div>
  );
}
