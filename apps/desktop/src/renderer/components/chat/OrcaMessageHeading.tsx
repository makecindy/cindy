import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageAutomationOrigin } from '@/lib/ccAgent.types';

export function OrcaMessageHeading({ source, origin }: {
  source: 'lead' | 'worker';
  origin?: MessageAutomationOrigin;
}) {
  const { t } = useTranslation();
  const orcaWorkerRole =
    origin?.kind === 'session' ? origin.orcaSenderLabel : undefined;
  const orcaHostNotice = origin?.kind === 'session' ? origin.orcaHostNotice : undefined;
  const orcaBatchCount = origin?.kind === 'session' ? origin.orcaAutoBridgeBatchCount : undefined;
  const orcaCardTitle =
    orcaHostNotice
      ? t('chat.userMessage.orcaFromHost')
      : orcaBatchCount
      ? t('chat.userMessage.orcaFromWorkerBatch', { count: orcaBatchCount })
      : source === 'lead'
        ? t('chat.userMessage.orcaFromLead')
        : orcaWorkerRole
          ? t('chat.userMessage.orcaFromWorkerNamed', { role: orcaWorkerRole })
          : t('chat.userMessage.orcaFromWorker');

  return <>
    <Bot size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
    <span className="min-w-0 flex-1 truncate">{orcaCardTitle}</span>
  </>;
}
