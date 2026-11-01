import { useEffect, useMemo, useState } from 'react';
import {
  type SessionUsageCostStatus,
  type SessionUsageSummary,
} from '@cindy/maker-shared/session-usage';
import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import type { AgentKind } from '@cindy/model-providers';

import { useChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useGatewayModelPricing, useReferenceModelPricing } from '@/hooks/useModelPricing';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import {
  buildConversationUsageFromStoredTurns,
  type StoredConversationUsageTurn,
} from '../../../shared/conversationUsage';

export type MessageWithTurnUsage = Pick<
  ChatMessage,
  'role' | 'turnUsageDetails' | 'turnMoney' | 'userTurnMoney' | 'model'
>;

export function formatCurrencyAmount(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `;
  const abs = Math.abs(amount);
  const decimals = abs > 0 && abs < 0.01 ? 4 : abs < 1 ? 4 : 2;
  const fixed = amount.toFixed(decimals);
  const trimmed =
    decimals > 2 ? fixed.replace(/(\.\d{2,}?)0+$/, '$1') : fixed;
  return `${symbol}${trimmed}`;
}

export function formatSessionUsageCost(
  cost: number | null,
  currency: string | undefined,
  costStatus: SessionUsageCostStatus,
): string | null {
  if (costStatus === 'none' || cost === null || !currency || !Number.isFinite(cost)) {
    return null;
  }
  const formatted = formatCurrencyAmount(cost, currency);
  return costStatus === 'partial' ? `~${formatted}` : formatted;
}

export function extractStoredTurnsFromMessages(
  messages: readonly MessageWithTurnUsage[],
): StoredConversationUsageTurn[] {
  if (!Array.isArray(messages)) return [];
  const turns: StoredConversationUsageTurn[] = [];
  for (const message of messages) {
    if (!message || message.role !== 'assistant' || !message.turnUsageDetails) continue;
    turns.push({
      turnUsageDetails: message.turnUsageDetails,
      turnMoney: message.turnMoney ?? message.userTurnMoney,
      model: message.model,
    });
  }
  return turns;
}

/**
 * Pure per-conversation usage and cost panel view (ROADMAP 1.9b-3).
 */
export function SessionUsagePanelView({ summary }: { summary: SessionUsageSummary }) {
  if (!summary || summary.turns <= 0 || summary.totalTokens <= 0) {
    return null;
  }

  const costLabel = formatSessionUsageCost(
    summary.cost,
    summary.currency,
    summary.costStatus,
  );
  const allLocal =
    summary.models.length > 0 && summary.models.every((entry) => entry.local);
  const unpricedSet = new Set(summary.unpricedModels);

  return (
    <details
      data-testid="session-usage-panel"
      className="relative mx-1 shrink-0"
      style={WINDOW_NO_DRAG_STYLE}
    >
      <summary
        data-testid="session-usage-trigger"
        className="cursor-pointer select-none list-none px-1.5 py-0.5 text-xs tabular-nums text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      >
        <span>{summary.tokensLabel} tok</span>
        {costLabel ? (
          <span>
            {' · '}
            {costLabel}
            {summary.costStatus === 'partial' ? ' (partial)' : ''}
          </span>
        ) : allLocal ? (
          <span> · local</span>
        ) : null}
      </summary>
      <div
        data-testid="session-usage-details"
        className="absolute left-0 top-full z-50 mt-1 min-w-[260px] border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2.5 text-xs tabular-nums text-[var(--text-primary)]"
        style={{ boxShadow: 'var(--shadow-menu)' }}
      >
        <div
          data-testid="session-usage-totals"
          className="flex items-baseline justify-between gap-3 text-[var(--text-secondary)]"
        >
          <span>
            {summary.turns} {summary.turns === 1 ? 'turn' : 'turns'}
          </span>
          <span>
            in {formatCompactTokens(summary.inputTokens)} · out{' '}
            {formatCompactTokens(summary.outputTokens)}
            {summary.cacheReadTokens > 0
              ? ` · cache R ${formatCompactTokens(summary.cacheReadTokens)}`
              : ''}
            {summary.cacheWriteTokens > 0
              ? ` · cache W ${formatCompactTokens(summary.cacheWriteTokens)}`
              : ''}
          </span>
        </div>

        <div
          data-testid="session-usage-cost"
          className="mt-1 font-medium text-[var(--text-primary)]"
        >
          {costLabel
            ? `Cost: ${costLabel}${summary.costStatus === 'partial' ? ' (partial)' : ''}`
            : allLocal
              ? 'Cost: local (tokens only)'
              : 'Cost: unpriced'}
        </div>

        <div className="mt-2 space-y-1 border-t border-[var(--border-default)] pt-1.5">
          {summary.models.map((row) => {
            const label = row.provider ? `${row.provider}/${row.model}` : row.model;
            const hasUnpriced = unpricedSet.has(row.model);
            const rowCost = row.local
              ? 'local'
              : row.cost !== null && row.currency
                ? hasUnpriced
                  ? `~${formatCurrencyAmount(row.cost, row.currency)}`
                  : formatCurrencyAmount(row.cost, row.currency)
                : 'unpriced';
            return (
              <div
                key={`${row.provider ?? ''}:${row.model}`}
                data-testid="session-usage-model-row"
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate text-[var(--text-primary)]">
                  {label}
                </span>
                <span className="shrink-0 text-[var(--text-secondary)]">
                  {formatCompactTokens(row.totalTokens)} tok · {rowCost}
                </span>
              </div>
            );
          })}
        </div>

        {summary.unpricedModels.length > 0 ? (
          <div
            data-testid="session-usage-unpriced"
            className="mt-1.5 border-t border-[var(--border-default)] pt-1 text-[var(--text-tertiary)]"
          >
            Unpriced: {summary.unpricedModels.join(', ')}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function toPricingAgentKind(agentKind: string | null | undefined): AgentKind | undefined {
  if (
    agentKind === 'hermes' ||
    agentKind === 'claude-code' ||
    agentKind === 'codex' ||
    agentKind === 'pi'
  ) {
    return agentKind;
  }
  if (agentKind === 'cc') return 'claude-code';
  return undefined;
}

/**
 * Connected per-conversation usage and cost panel mounted in `SessionContentHeader`.
 */
export function SessionUsagePanel({
  sessionId,
  defaultModel,
  defaultProvider,
  agentKind,
}: {
  sessionId: string;
  defaultModel?: string | null;
  defaultProvider?: string | null;
  agentKind?: string | null;
}) {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const [storeMessages, setStoreMessages] = useState<readonly ChatMessage[]>(() =>
    sessionId ? makerChatStore.getSnapshot(sessionId).messages : [],
  );

  useEffect(() => {
    if (displaySnapshot) return undefined;
    if (!sessionId) {
      setStoreMessages([]);
      return undefined;
    }
    const update = () => {
      setStoreMessages(makerChatStore.getSnapshot(sessionId).messages);
    };
    update();
    return makerChatStore.subscribe(sessionId, update);
  }, [displaySnapshot, sessionId]);

  const gatewayPricing = useGatewayModelPricing();
  const referencePricing = useReferenceModelPricing();
  const messages = displaySnapshot ? displaySnapshot.messages : storeMessages;

  const summary = useMemo(() => {
    const turns = extractStoredTurnsFromMessages(messages);
    return buildConversationUsageFromStoredTurns(turns, {
      gatewayPricing,
      referencePricing,
      defaultModel,
      defaultProvider,
      agent: toPricingAgentKind(agentKind),
    });
  }, [agentKind, defaultModel, defaultProvider, gatewayPricing, messages, referencePricing]);

  return <SessionUsagePanelView summary={summary} />;
}
