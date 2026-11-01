import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildConversationUsageFromStoredTurns } from '../../shared/conversationUsage';
import { registryPricingCatalog } from '../../shared/modelPriceQuote';
import type { ModelPricingCatalog } from '../../shared/regionalMoney';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';
import {
  extractStoredTurnsFromMessages,
  formatSessionUsageCost,
  SessionUsagePanelView,
  type MessageWithTurnUsage,
} from '../features/cc-agent/SessionUsagePanel';

const REFERENCE_PRICING: ModelPricingCatalog = registryPricingCatalog(
  BUNDLED_CATALOG.modelRegistry,
);

describe('SessionUsagePanel (ROADMAP 1.9b-3)', () => {
  it('renders nothing when the conversation has no recorded usage turns', () => {
    const summary = buildConversationUsageFromStoredTurns([]);
    expect(renderToStaticMarkup(<SessionUsagePanelView summary={summary} />)).toBe('');
  });

  it('extracts only assistant messages that carry turnUsageDetails and renders complete cost and model breakdown', () => {
    const messages: MessageWithTurnUsage[] = [
      {
        role: 'user',
        turnUsageDetails: buildTurnUsageDetails({
          inputTokens: 99_999,
          outputTokens: 99_999,
          model: 'deepseek-flash',
          provider: 'deepseek',
        })!,
      },
      {
        role: 'assistant',
        turnUsageDetails: undefined,
      },
      {
        role: 'assistant',
        turnUsageDetails: buildTurnUsageDetails({
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 5_000,
          model: 'deepseek-flash',
          provider: 'deepseek',
        })!,
      },
    ];

    const turns = extractStoredTurnsFromMessages(messages);
    expect(turns).toHaveLength(1);

    const summary = buildConversationUsageFromStoredTurns(turns, {
      referencePricing: REFERENCE_PRICING,
    });
    const html = renderToStaticMarkup(<SessionUsagePanelView summary={summary} />);

    expect(html).toContain('data-testid="session-usage-panel"');
    expect(html).toContain('16.0k tok');
    expect(html).toContain('$0.0042');
    expect(html).toContain('1 turn');
    expect(html).toContain('in 10.0k · out 1.0k · cache R 5.0k');
    expect(html).toContain('Cost: $0.0042');
    expect(html).toContain('deepseek/deepseek-flash');
    expect(html).not.toContain('session-usage-unpriced');
  });

  it('renders partial cost and lists unpriced models when a turn cannot be priced', () => {
    const summary = buildConversationUsageFromStoredTurns(
      [
        {
          turnUsageDetails: {
            inputTokens: 10_000,
            outputTokens: 2_000,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 12_000,
            model: 'claude-sonnet-4-6',
            provider: 'anthropic',
            perModelCost: [
              {
                model: 'claude-sonnet-4-6',
                money: {
                  amount: 0.03,
                  currency: 'USD',
                  approximate: false,
                  kind: 'actual-cost',
                },
              },
            ],
          },
        },
        {
          turnUsageDetails: {
            inputTokens: 3_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 4_000,
            model: 'mystery-unpriced-model',
            provider: 'custom-remote',
          },
        },
      ],
      { referencePricing: REFERENCE_PRICING },
    );

    const html = renderToStaticMarkup(<SessionUsagePanelView summary={summary} />);
    expect(html).toContain('16.0k tok');
    expect(html).toContain('~$0.03 (partial)');
    expect(html).toContain('Cost: ~$0.03 (partial)');
    expect(html).toContain('Unpriced: mystery-unpriced-model');
    expect(html).toContain('custom-remote/mystery-unpriced-model');
  });

  it('renders tokens-only local badge for local model conversations without pricing them', () => {
    const summary = buildConversationUsageFromStoredTurns(
      [
        {
          local: true,
          turnUsageDetails: {
            inputTokens: 4_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 5_000,
            model: 'qwen3-8b',
            provider: 'lmstudio-local',
          },
        },
      ],
      { referencePricing: REFERENCE_PRICING },
    );

    const html = renderToStaticMarkup(<SessionUsagePanelView summary={summary} />);
    expect(html).toContain('5.0k tok');
    expect(html).toContain('· local');
    expect(html).toContain('Cost: local (tokens only)');
    expect(html).toContain('lmstudio-local/qwen3-8b');
    expect(html).not.toContain('$');
    expect(formatSessionUsageCost(summary.cost, summary.currency, summary.costStatus)).toBeNull();
  });
});
