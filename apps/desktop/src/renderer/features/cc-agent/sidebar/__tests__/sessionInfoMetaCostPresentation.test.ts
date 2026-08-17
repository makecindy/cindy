import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { buildSessionInfoPieces } from '../SessionInfoMeta';

const t = (key: string): string => key;

function session(totalMoney: Session['totalMoney']): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    title: 'Test',
    agentKind: 'cc',
    status: 'active',
    workingDir: null,
    workspaceKind: 'project',
    remoteHostId: null,
    providerId: 'custom-provider',
    model: 'custom-model',
    effort: 'high',
    permissionMode: 'default',
    sdkSessionId: null,
    totalCostUsd: totalMoney?.currency === 'USD' ? totalMoney.amount : 0,
    totalMoney,
    totalTokenUsage: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    extraDirs: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('sidebar session cost presentation', () => {
  it('renders no cost after the per-turn projection removes a custom-provider SDK amount', () => {
    const pieces = buildSessionInfoPieces(
      session(undefined),
      ['cost'],
      undefined,
      t,
      false,
      'hidden',
    );
    expect(pieces).toEqual([]);
  });

  it('labels the projected custom-provider amount as an SDK estimate when enabled', () => {
    const pieces = buildSessionInfoPieces(
      session({
        amount: 0.42,
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['sdk-estimate'],
      }),
      ['cost'],
      undefined,
      t,
      false,
      'estimate',
    );
    expect(pieces).toEqual([
      expect.objectContaining({
        key: 'cost',
        text: '$0.42',
        title: 'ccAgent.sidebar.taskInfoTip.sdkEstimate',
      }),
    ]);
  });

  it('does not label a mixed actual-cost and SDK-estimate total as a pure SDK estimate', () => {
    const pieces = buildSessionInfoPieces(
      session({
        amount: 0.75,
        currency: 'USD',
        approximate: true,
        kind: 'actual-cost',
        estimateReasons: ['sdk-estimate'],
      }),
      ['cost'],
      undefined,
      t,
    );
    expect(pieces).toEqual([
      expect.objectContaining({
        key: 'cost',
        text: '$0.75',
        title: 'ccAgent.sidebar.taskInfoTip.cost',
      }),
    ]);
  });
});
