import { describe, expect, it } from 'vitest';

import {
  billingSessionForRevision,
  mobileSessionBillingRevision,
  projectMobileMessageBilling,
  projectSessionBilling,
  resolveMobileSdkCostPresentation,
  withoutSessionMoney,
} from '@/session/sessionBillingProjection';
import type { RemoteMessage } from '@/session/types';
import type { RemoteSession } from '@/session/types';

function session(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 'session-1',
    userId: 'user-1',
    title: 'Task',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'model-1',
    effort: '',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

function assistantMessage(
  clientId: string,
  agentMeta: Record<string, unknown>,
  createdAt: string = '2026-08-18T00:00:01.000Z',
): RemoteMessage {
  return {
    id: clientId,
    clientId,
    sessionId: 'session-1',
    role: 'assistant',
    content: clientId,
    toolUseId: null,
    agentMeta,
    createdAt,
  };
}

describe('mobile custom-provider billing projection', () => {
  it('uses the host opt-in only for custom or unknown provider ids', () => {
    const providers = [
      { id: 'anthropic', source: 'builtin' },
      { id: 'private-gateway', source: 'custom' },
    ];
    expect(resolveMobileSdkCostPresentation('anthropic', providers, false)).toBe('regular');
    expect(resolveMobileSdkCostPresentation('private-gateway', providers, false)).toBe('hidden');
    expect(resolveMobileSdkCostPresentation('private-gateway', providers, true)).toBe('estimate');
    expect(resolveMobileSdkCostPresentation('deleted-provider', providers, false)).toBe('hidden');
    expect(resolveMobileSdkCostPresentation(null, providers, false)).toBe('regular');
  });

  it('fails closed to a token-only session while the projection is unavailable', () => {
    expect(withoutSessionMoney(session({
      totalCostUsd: 0.42,
      totalMoney: {
        amount: 0.42,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
      totalTokenUsage: 12_000,
    }))).toMatchObject({
      totalCostUsd: 0,
      totalTokenUsage: 12_000,
    });
    expect(withoutSessionMoney(session({ totalCostUsd: 0.42 })).totalMoney).toBeUndefined();
  });

  it('subtracts historical SDK amounts and keeps independent estimates visible', () => {
    const projected = projectSessionBilling(
      session({
        totalCostUsd: 0.52,
        totalMoney: {
          amount: 0.52,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      }),
      {
        totalValueMoney: {
          amount: 0.07,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['reference-price'],
        },
        entries: [{
          clientId: 'historical-sdk',
          excludedActualMoney: {
            amount: 0.42,
            currency: 'USD',
            approximate: false,
            kind: 'actual-cost',
          },
        }],
      },
    );

    expect(projected.totalMoney).toMatchObject({
      currency: 'USD',
      kind: 'actual-cost',
    });
    expect(projected.totalMoney?.amount).toBeCloseTo(0.17, 10);
    expect(projected.totalCostUsd).toBeCloseTo(0.17, 10);
  });

  it('shows an SDK estimate when the host opt-in includes it in the projection', () => {
    const projected = projectSessionBilling(session(), {
      totalValueMoney: {
        amount: 0.42,
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['sdk-estimate'],
      },
      entries: [],
    });

    expect(projected.totalMoney).toMatchObject({
      amount: 0.42,
      kind: 'value-estimate',
      estimateReasons: ['sdk-estimate'],
    });
    expect(projected.totalCostUsd).toBeCloseTo(0.42, 10);
  });

  it('revisions persisted money and assistant billing metadata without message bodies', () => {
    const base = session({ totalCostUsd: 0.1 });
    const message = {
      id: 'message-1',
      clientId: 'assistant-1',
      sessionId: base.id,
      role: 'assistant',
      content: 'first body',
      toolUseId: null,
      agentMeta: {
        turnCost: {
          amount: 0.1,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['sdk-estimate'],
        },
        turnCostIsCustomProvider: true,
      },
      createdAt: '2026-08-18T00:00:01.000Z',
    } satisfies RemoteMessage;
    const first = mobileSessionBillingRevision(base, [message]);

    expect(mobileSessionBillingRevision(base, [{ ...message, content: 'changed body' }])).toBe(first);
    expect(mobileSessionBillingRevision(
      { ...base, totalCostUsd: 0.2 },
      [message],
    )).not.toBe(first);
    expect(mobileSessionBillingRevision(base, [{
      ...message,
      agentMeta: { ...message.agentMeta, turnCostUsd: 0.2 },
    }])).not.toBe(first);
    expect(mobileSessionBillingRevision(base, [{
      ...message,
      agentMeta: { ...message.agentMeta, userTurnCostUsd: 0.3 },
    }])).not.toBe(first);
  });

  it('uses host exclusions to hide legacy custom-provider SDK amounts without a turn marker', () => {
    const [projected] = projectMobileMessageBilling([
      assistantMessage('legacy-sdk', {
        turnCost: {
          amount: 0.42,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
        turnCostUsd: 0.42,
        turnUsageDetails: { totalTokens: 12_345 },
      }),
    ], {
      presentation: 'hidden',
      showSdkEstimate: false,
      entries: [{
        clientId: 'legacy-sdk',
        excludedActualMoney: {
          amount: 0.42,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      }],
    });

    expect(projected.agentMeta).not.toHaveProperty('turnCost');
    expect(projected.agentMeta).not.toHaveProperty('turnCostUsd');
    expect(projected.agentMeta?.turnUsageDetails).toEqual({ totalTokens: 12_345 });
  });

  it('uses the host estimate when SDK display is explicitly enabled', () => {
    const [projected] = projectMobileMessageBilling([
      assistantMessage('legacy-sdk', {
        turnCostUsd: 0.42,
        turnCostIsEstimate: false,
      }),
    ], {
      presentation: 'estimate',
      showSdkEstimate: true,
      entries: [{
        clientId: 'legacy-sdk',
        money: {
          amount: 0.42,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['sdk-estimate'],
        },
        excludedActualMoney: {
          amount: 0.42,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      }],
    });

    expect(projected.agentMeta).toMatchObject({
      turnCostUsd: 0.42,
      turnCostIsEstimate: true,
      turnCost: {
        amount: 0.42,
        kind: 'value-estimate',
        estimateReasons: ['sdk-estimate'],
      },
    });
  });

  it('preserves reference-price portions and rebuilds multi-segment user totals across auto-resume', () => {
    const messages: RemoteMessage[] = [
      {
        id: 'user-1',
        clientId: 'user-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'question',
        toolUseId: null,
        agentMeta: null,
        createdAt: '2026-08-18T00:00:00.000Z',
      },
      assistantMessage('segment-1', {
        turnCostIsCustomProvider: true,
        turnCost: {
          amount: 0.6,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['reference-price', 'sdk-estimate'],
        },
        userTurnCostUsd: 0.6,
        turnUsageDetails: {
          totalTokens: 100,
          perModelCost: [
            {
              model: 'reference-model',
              money: {
                amount: 0.2,
                currency: 'USD',
                approximate: true,
                kind: 'value-estimate',
                estimateReasons: ['reference-price'],
              },
            },
            {
              model: 'sdk-model',
              money: {
                amount: 0.4,
                currency: 'USD',
                approximate: true,
                kind: 'value-estimate',
                estimateReasons: ['sdk-estimate'],
              },
            },
          ],
        },
      }),
      {
        id: 'auto-resume',
        clientId: 'auto-resume',
        sessionId: 'session-1',
        role: 'user',
        content: '',
        toolUseId: null,
        agentMeta: { autoResume: true },
        createdAt: '2026-08-18T00:00:02.000Z',
      },
      assistantMessage('segment-2', {
        turnCostIsCustomProvider: true,
        turnCost: {
          amount: 0.3,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['reference-price'],
        },
        userTurnCostUsd: 0.9,
      }, '2026-08-18T00:00:03.000Z'),
    ];
    const projected = projectMobileMessageBilling(messages, {
      presentation: 'hidden',
      showSdkEstimate: false,
      entries: [
        {
          clientId: 'segment-1',
          money: {
            amount: 0.2,
            currency: 'USD',
            approximate: true,
            kind: 'value-estimate',
            estimateReasons: ['reference-price'],
          },
          turnCostIsCustomProvider: true,
          turnUsageDetails: messages[1].agentMeta?.turnUsageDetails,
        },
        {
          clientId: 'segment-2',
          money: {
            amount: 0.3,
            currency: 'USD',
            approximate: true,
            kind: 'value-estimate',
            estimateReasons: ['reference-price'],
          },
          turnCostIsCustomProvider: true,
        },
      ],
    });

    expect(projected[1].agentMeta).toMatchObject({
      turnCostUsd: 0.2,
      userTurnCostUsd: 0.2,
      turnUsageDetails: {
        perModelCost: [{ model: 'reference-model' }],
      },
    });
    expect(projected[3].agentMeta).toMatchObject({
      turnCostUsd: 0.3,
      userTurnCostUsd: 0.5,
    });
  });

  it('does not persist a /cost projection built for an older session revision', () => {
    const before = session({ totalCostUsd: 0.1 });
    const revision = mobileSessionBillingRevision(before, []);
    const projection = session({
      totalCostUsd: 0.1,
      totalMoney: {
        amount: 0.1,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
    });

    expect(billingSessionForRevision(before, [], projection, revision)).toBe(projection);
    const after = { ...before, totalCostUsd: 0.2 };
    expect(billingSessionForRevision(after, [], projection, revision)).toMatchObject({
      totalCostUsd: 0,
    });
    expect(
      billingSessionForRevision(after, [], projection, revision).totalMoney,
    ).toBeUndefined();
  });
});
