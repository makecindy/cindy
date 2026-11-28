import { useTranslation } from 'react-i18next';
import { UsageCostPopover } from '@/components/status/UsageCostPopover';
import { TurnGenerationTrace } from '@/components/status/TurnGenerationTrace';
import { aggregateAssistantTurnUsageDetails } from '@/lib/userTurnUsage';
import type { ChatMessage } from '@/lib/makerChatStore';
import { formatSessionDuration } from '@/lib/sessionDurationFormat';
import { formatCompactTokens } from '@/lib/usageFormat';
import { buildTurnUsageTooltipLines } from '@/lib/turnUsageTooltip';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import { traceHasChart } from '@cindy/maker-shared/usage-format';

/** Only the current user turn may supply idle statistics; never reuse an older turn's figures. */
export function latestTurnStatistics(messages: readonly ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && message.delivery !== 'steer' && message.systemCardType !== 'auto-resume') return null;
    if (message.role === 'assistant' && message.turnUsageDetails) {
      const details = aggregateAssistantTurnUsageDetails(messages, message.clientId);
      return details ? { clientId: message.clientId, details } : null;
    }
  }
  return null;
}

/** Static saved figures: this row never starts a clock, samples speed or reads a server. */
export function LastTurnStatistics({ details }: { details: TurnUsageDetails }) {
  const { t } = useTranslation();
  const elapsed = details.turnDurationMs === undefined ? null : formatSessionDuration(details.turnDurationMs, t);
  const output = t('chat.runningStatus.tokenCount', { tokens: formatCompactTokens(details.outputTokens) });
  return <div className="flex min-w-0 items-center" data-last-turn-statistics>
    <UsageCostPopover
      className="flex items-center gap-1.5 text-13 tabular-nums text-[var(--status-bar-meta)]"
      label={<>{elapsed && <><span>{elapsed}</span><span aria-hidden>·</span></>}<span>↓ {output}</span></>}
      header={details.trace && traceHasChart(details.trace) ? <TurnGenerationTrace trace={details.trace} /> : undefined}
      fallback={<div className="whitespace-pre-line text-12 text-[var(--text-secondary)]">{buildTurnUsageTooltipLines({ details, t }).join('\n')}</div>}
    />
  </div>;
}
