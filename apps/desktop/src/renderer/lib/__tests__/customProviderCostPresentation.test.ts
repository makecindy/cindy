import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/lib/makerChatStore';
import {
  projectCustomProviderMessages,
  projectCustomProviderMoney,
  resolveCustomProviderCostPresentation,
} from '@/lib/customProviderCostPresentation';
import type { RegionalMoney } from '../../../shared/regionalMoney';

function money(
  amount: number,
  kind: RegionalMoney['kind'],
  estimateReasons?: RegionalMoney['estimateReasons'],
): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: kind === 'value-estimate',
    kind,
    ...(estimateReasons ? { estimateReasons } : {}),
  };
}

function message(values: Partial<ChatMessage>): ChatMessage {
  return {
    clientId: crypto.randomUUID(),
    role: 'assistant',
    content: 'done',
    ...values,
  } as ChatMessage;
}

describe('custom provider cost presentation', () => {
  it('resolves only user-defined providers to the custom presentation', () => {
    const providers = [
      { id: 'anthropic', source: 'builtin' as const },
      { id: 'my-provider', source: 'user' as const },
    ];
    expect(resolveCustomProviderCostPresentation('anthropic', providers, false)).toBe('regular');
    expect(resolveCustomProviderCostPresentation('my-provider', providers, false)).toBe('hidden');
    expect(resolveCustomProviderCostPresentation('my-provider', providers, true)).toBe('estimate');
    expect(resolveCustomProviderCostPresentation('deleted-provider', providers, false)).toBe(
      'hidden',
    );
    expect(resolveCustomProviderCostPresentation('remote-provider', [], false)).toBe('hidden');
  });

  it('hides SDK values while preserving user and provider price estimates', () => {
    expect(projectCustomProviderMoney(money(2, 'actual-cost'), 'hidden')).toBeNull();
    expect(
      projectCustomProviderMoney(money(3, 'value-estimate', ['sdk-estimate']), 'hidden'),
    ).toBeNull();
    expect(
      projectCustomProviderMoney(money(4, 'value-estimate', ['reference-price']), 'hidden'),
    ).toMatchObject({ amount: 4, kind: 'value-estimate' });
  });

  it('relabels historical actual values and per-model rows as SDK estimates', () => {
    const [projected] = projectCustomProviderMessages(
      [
        message({
          turnMoney: money(2, 'actual-cost'),
          userTurnMoney: money(2, 'actual-cost'),
          turnUsageDetails: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 15,
            cacheHitRate: null,
            perModelCost: [{ model: 'm', money: money(2, 'actual-cost') }],
          },
        }),
      ],
      'estimate',
    );
    expect(projected.turnMoney).toMatchObject({ kind: 'value-estimate' });
    expect(projected.turnMoney?.estimateReasons).toContain('sdk-estimate');
    expect(projected.turnMoney?.estimateReasons).not.toContain('subscription-value');
    expect(projected.turnUsageDetails?.perModelCost?.[0].money).toMatchObject({
      kind: 'value-estimate',
    });
  });

  it('rebuilds the user-round total after filtering SDK segments', () => {
    const projected = projectCustomProviderMessages(
      [
        message({ role: 'user', content: 'go' }),
        message({ turnMoney: money(2, 'actual-cost'), userTurnMoney: money(2, 'actual-cost') }),
        message({
          turnMoney: money(4, 'value-estimate', ['reference-price']),
          userTurnMoney: money(6, 'actual-cost'),
        }),
      ],
      'hidden',
    );
    expect(projected[1].turnMoney).toBeUndefined();
    expect(projected[2].turnMoney).toMatchObject({ amount: 4, kind: 'value-estimate' });
    expect(projected[2].userTurnMoney).toMatchObject({ amount: 4, kind: 'value-estimate' });
  });

  it('uses immutable per-turn provider attribution when a session switches providers', () => {
    const builtInThenCustom = projectCustomProviderMessages(
      [
        message({
          clientId: 'built-in-before-switch',
          turnMoney: money(1, 'actual-cost'),
          turnCostIsCustomProvider: false,
        }),
        message({
          clientId: 'custom-after-switch',
          turnMoney: money(2, 'actual-cost'),
          turnCostIsCustomProvider: true,
        }),
      ],
      'hidden',
      false,
    );
    expect(builtInThenCustom[0].turnMoney).toMatchObject({ amount: 1, kind: 'actual-cost' });
    expect(builtInThenCustom[1].turnMoney).toBeUndefined();

    const customThenBuiltIn = projectCustomProviderMessages(
      [
        message({
          clientId: 'custom-before-switch',
          turnMoney: money(2, 'actual-cost'),
          turnCostIsCustomProvider: true,
        }),
        message({
          clientId: 'built-in-after-switch',
          turnMoney: money(1, 'actual-cost'),
          turnCostIsCustomProvider: false,
        }),
      ],
      'regular',
      false,
    );
    expect(customThenBuiltIn[0].turnMoney).toBeUndefined();
    expect(customThenBuiltIn[1].turnMoney).toMatchObject({ amount: 1, kind: 'actual-cost' });
  });

  it('projects unattributed legacy rows safely when an older remote Host lacks per-turn fields', () => {
    const legacyRows = [
      message({
        clientId: 'legacy-custom',
        model: 'deleted-custom-model',
        turnMoney: money(2, 'actual-cost'),
      }),
      message({
        clientId: 'legacy-gateway',
        model: 'claude-sonnet-4-6',
        turnMoney: money(1, 'actual-cost'),
      }),
      message({
        clientId: 'legacy-user-total-only',
        model: 'claude-sonnet-4-6',
        userTurnMoney: money(3, 'actual-cost'),
      }),
    ];

    for (const fallback of ['regular', 'hidden'] as const) {
      const projected = projectCustomProviderMessages(legacyRows, fallback, false);
      expect(projected[0].turnMoney).toBeUndefined();
      expect(projected[1].turnMoney).toMatchObject({ amount: 1, kind: 'actual-cost' });
      expect(projected[2].userTurnMoney).toBeUndefined();
    }
  });

  it('fails closed for a mixed cumulative total on an estimated closing segment', () => {
    const closing = message({
      clientId: 'legacy-estimated-closing-segment',
      model: 'claude-sonnet-4-6',
      turnMoney: money(4, 'value-estimate', ['reference-price']),
      turnCostIsEstimate: true,
      userTurnMoney: money(6, 'actual-cost'),
    });

    const [hidden] = projectCustomProviderMessages([closing], 'regular', false);
    expect(hidden.turnMoney).toMatchObject({
      amount: 4,
      kind: 'value-estimate',
      estimateReasons: ['reference-price'],
    });
    expect(hidden.userTurnMoney).toBeUndefined();

    const [estimated] = projectCustomProviderMessages([closing], 'regular', true);
    expect(estimated.userTurnMoney).toMatchObject({
      amount: 6,
      kind: 'value-estimate',
      estimateReasons: ['sdk-estimate'],
    });
  });

  it('keeps reference-priced portions of a mixed custom-provider estimate', () => {
    const [projected] = projectCustomProviderMessages(
      [
        message({
          turnMoney: money(5, 'value-estimate', ['reference-price', 'sdk-estimate']),
          turnCostIsEstimate: true,
          turnCostIsCustomProvider: true,
          turnUsageDetails: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            totalTokens: 15,
            cacheHitRate: null,
            perModelCost: [
              { model: 'sdk-model', money: money(2, 'value-estimate', ['sdk-estimate']) },
              {
                model: 'quoted-model',
                money: money(3, 'value-estimate', ['reference-price']),
              },
            ],
          },
        }),
      ],
      'regular',
      false,
    );

    expect(projected.turnMoney).toMatchObject({ amount: 3, kind: 'value-estimate' });
    expect(projected.turnMoney?.estimateReasons).toEqual(['reference-price']);
    expect(projected.turnUsageDetails?.perModelCost).toEqual([
      {
        model: 'quoted-model',
        money: expect.objectContaining({ amount: 3, estimateReasons: ['reference-price'] }),
      },
    ]);
  });
});
