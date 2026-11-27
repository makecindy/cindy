/**
 * 测试价值
 * - 生产入口与可观察结果：sessionCreateToRow / sessionToCamel、redactSessionRowForSharedGuest /
 *   redactSharedGuestPush、coerceCachedSession、projectRemoteSessionResult 四条真实边界入口，
 *   验证 createdBySession 的落库往返、与 parentSessionId 隔离、共享访客脱敏、离线缓存保留与隐藏伙伴剥离。
 * - Bug／规则依据：docs/product-rules/message-source.md、docs/dev-rules/protocol-compatibility.md
 *   与 sessions.parent_session_id 仅用于 fork / 侧边追问的不变量。
 * - 现有覆盖缺口：此前无会话级来源列，也没有验证离线缓存保留 orcaRemoteLead / createdBySession
 *   以及共享访客会话行脱敏的回归测试。
 * - 最小失败输入：单条带 createdBySession / orcaRemoteLead 的会话行（含损坏 JSON 与隐藏来源任务 ID）。
 * - tier：unit（纯进程内，无磁盘/网络）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildSessionCreatedBy, parseSessionCreatedBy } from '../../../shared/sessionOrigin';
import { sessionCreateToRow, sessionToCamel } from '../../localDb/mapper';
import { coerceCachedSession } from '../mirrorCacheStore';
import { projectRemoteSessionResult, setRemoteBotSessionLookup } from '../remoteBotSessionBoundary';
import { redactSessionRowForSharedGuest, redactSharedGuestPush } from '../sharedTaskMessageOrigin';

afterEach(() => {
  setRemoteBotSessionLookup(null);
});

describe('session-level origin persistence and privacy boundaries', () => {
  it('round-trips createdBySession through mapper without touching parentSessionId and tolerates corrupted JSON', () => {
    const origin = buildSessionCreatedBy({
      sessionId: 'origin-task-1',
      title: 'Fix sidebar\n\rbugs',
      botId: 'bot-1',
      botName: 'Alex',
    });
    expect(origin).toEqual({
      kind: 'session',
      sessionId: 'origin-task-1',
      title: 'Fix sidebar bugs',
      botId: 'bot-1',
      botName: 'Alex',
    });

    const row = sessionCreateToRow('child-task', {
      title: 'Follow up PR',
      model: 'claude-sonnet-4-6',
      createdBySession: origin,
    }, 1_700_000_000_000);

    expect(row.parentSessionId).toBeNull();
    expect(typeof row.createdBySession).toBe('string');

    const camel = sessionToCamel({
      ...row,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      totalCostUsdIsApproximate: false,
      totalCostCurrency: null,
      totalCostAmount: 0,
      totalCostIsApproximate: false,
      contextTokens: 0,
      contextWindow: 0,
      fastMode: false,
      planModeEnabled: false,
      clearedAt: null,
      pinnedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      hiddenAt: null,
      notificationsMuted: false,
      userSendAt: null,
      lastActivityAt: null,
      sideChatPromoted: false,
      orcaRole: null,
      parentSessionId: null,
      forkedAtMessageId: null,
      worktreePath: null,
      usedProjectContext: false,
      extraDirs: '[]',
      writableDirs: '[]',
      remoteHostId: null,
      agentDeviceId: null,
      orcaRemoteLead: null,
      activeTurnStartedAt: null,
      activeTurnPid: null,
      lastTurnEndedAt: null,
      listPreview: null,
      listPreviewRole: null,
      listMessageCount: null,
      scheduledModelBaseline: null,
      summary: null,
      messageCount: 1,
    } as Parameters<typeof sessionToCamel>[0]);

    expect(camel.parentSessionId).toBeNull();
    expect(camel.createdBySession).toEqual(origin);
    expect(parseSessionCreatedBy('{broken-json')).toBeNull();
    expect(parseSessionCreatedBy({ kind: 'session', sessionId: '' })).toBeNull();
  });

  it('strips createdBySession and orcaRemoteLead from shared-task guest reads and pushes', () => {
    const row = {
      id: 'shared-1',
      title: 'Shared task',
      createdBySession: { kind: 'session', sessionId: 'private-task', title: 'Private plan' },
      orcaRemoteLead: {
        leadDeviceId: 'dev-a',
        leadDeviceName: 'Office Mac',
        leadSessionId: 'lead-1',
        leadTitle: 'Secret team',
        workerLabel: 'worker-a',
      },
    };
    expect(redactSessionRowForSharedGuest(row)).toMatchObject({
      id: 'shared-1',
      createdBySession: null,
      orcaRemoteLead: null,
    });
    expect(redactSharedGuestPush('local-db:sessions:created', { session: row })).toEqual({
      session: { id: 'shared-1', title: 'Shared task', createdBySession: null, orcaRemoteLead: null },
    });
    expect(redactSharedGuestPush('local-db:sessions:patched', { sessionId: 'shared-1', patch: { createdBySession: row.createdBySession } }))
      .toEqual({ sessionId: 'shared-1', patch: { createdBySession: null } });
  });

  it('preserves valid orcaRemoteLead and createdBySession in offline mirror cache and drops invalid payloads', () => {
    const valid = coerceCachedSession({
      id: 's1',
      status: 'active',
      title: 'Task',
      orcaRemoteLead: {
        leadDeviceId: 'dev-a',
        leadDeviceName: 'Studio',
        leadSessionId: 'lead-1',
        leadTitle: 'Release',
        workerLabel: 'w1',
      },
      createdBySession: {
        kind: 'session',
        sessionId: 'dev-a::parent-1',
        title: 'Triage',
        deviceId: 'dev-a',
        deviceName: 'Studio',
      },
    });
    expect(valid?.orcaRemoteLead).toMatchObject({ leadDeviceId: 'dev-a', workerLabel: 'w1' });
    expect(valid?.createdBySession).toMatchObject({ kind: 'session', sessionId: 'dev-a::parent-1', deviceName: 'Studio' });

    const invalid = coerceCachedSession({
      id: 's2',
      status: 'active',
      title: 'Task',
      orcaRemoteLead: { bogus: true },
      createdBySession: { kind: 'other', sessionId: 'x' },
    });
    expect(invalid).not.toHaveProperty('orcaRemoteLead');
    expect(invalid).not.toHaveProperty('createdBySession');
  });

  it('omits hidden/background createdBySession on list channels while keeping background on exact-ID reads and failing closed on incomplete batches', async () => {
    setRemoteBotSessionLookup(async (id) => (
      id === 'hidden-owner' ? 'hidden'
        : id === 'hidden-companion' ? 'background'
          : 'ordinary'
    ));
    const deniedOriginRow = {
      id: 'visible-1',
      createdBySession: { kind: 'session', sessionId: 'hidden-owner', title: 'Denied' },
    };
    const backgroundCompanionOriginRow = {
      id: 'visible-bg',
      createdBySession: { kind: 'session', sessionId: 'hidden-companion', title: 'Hidden companion' },
    };
    const visibleOriginRow = {
      id: 'visible-2',
      createdBySession: { kind: 'session', sessionId: 'ordinary-origin', title: 'Public' },
    };
    const crossDeviceOriginRow = {
      id: 'visible-3',
      createdBySession: { kind: 'session', sessionId: 'other-device::hidden-companion', title: 'Remote', deviceId: 'other-device' },
    };

    const listed = await projectRemoteSessionResult('local-db:sessions:list', [
      deniedOriginRow,
      backgroundCompanionOriginRow,
      visibleOriginRow,
      crossDeviceOriginRow,
    ]) as Array<Record<string, unknown>>;

    expect(listed).toEqual([
      { id: 'visible-1' },
      { id: 'visible-bg' },
      visibleOriginRow,
      crossDeviceOriginRow,
    ]);
    expect(await projectRemoteSessionResult('local-db:sessions:get', deniedOriginRow)).toEqual({ id: 'visible-1' });
    expect(await projectRemoteSessionResult('local-db:sessions:get', backgroundCompanionOriginRow)).toEqual(backgroundCompanionOriginRow);

    // Incomplete batch result must fail closed for createdBySession too.
    setRemoteBotSessionLookup(
      async () => 'ordinary',
      async () => new Map([['visible-2', 'ordinary']]),
    );
    expect(await projectRemoteSessionResult('local-db:sessions:list', [visibleOriginRow])).toEqual([{ id: 'visible-2' }]);
  });
});
