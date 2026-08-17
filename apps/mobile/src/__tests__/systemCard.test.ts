import { describe, expect, it } from 'vitest';
import {
  MOBILE_LOCAL_SYSTEM_COMMANDS,
  buildMobileSystemCardData,
  commandNeedsRemoteSession,
  formatMobileSystemCard,
  mergeMobileLocalSlashCommands,
  parseMobileLocalSystemCommand,
} from '@/session/systemCard';
import type { InputProjection, RemoteSession } from '@/session/types';
import { i18n } from '@/i18n';

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 's1',
    userId: 'u1',
    title: 'Session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: true,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

const projection: InputProjection = {
  sessionId: 's1',
  pendingQueue: [],
  steeringQueueClientIds: [],
  queuePaused: false,
  queueExpanded: false,
  queueInteractionLocks: [],
  queueEditLocks: [],
  queueAbortPending: false,
  error: null,
  errorRetryText: null,
    credentialSwitchWait: null,
};

describe('systemCard', () => {
  it('detects only mobile-local system slash commands', () => {
    expect(parseMobileLocalSystemCommand('/help')).toBe('help');
    expect(parseMobileLocalSystemCommand('/context ')).toBe('context');
    expect(parseMobileLocalSystemCommand('/compact')).toBeNull();
    expect(parseMobileLocalSystemCommand('/help now')).toBeNull();
  });

  it('keeps mobile-local commands before remote slash commands', () => {
    expect(mergeMobileLocalSlashCommands([
      { kind: 'agent-builtin', name: 'help', description: 'remote help' },
      { kind: 'agent-builtin', name: 'doctor', description: 'remote doctor' },
    ]).map((command) => [command.name, command.description])).toEqual([
      ['help', '显示手机端和远程 agent 命令'],
      ['context', '查看当前任务上下文用量'],
      ['cost', '查看当前任务消耗'],
      ['pwd', '显示当前远程工作目录'],
      ['status', '显示当前任务状态'],
      ['doctor', 'remote doctor'],
    ]);
  });

  it('formats status and context cards from current mobile state', () => {
    const status = formatMobileSystemCard('status', buildMobileSystemCardData('status', {
      projection: { ...projection, pendingQueue: [{ clientId: 'q1' } as never], queuePaused: true },
      session: session(),
    }));

    expect(status).toMatchObject({
      title: 'Session Status',
      rows: expect.arrayContaining([
        { label: 'agent', value: 'Claude Code' },
        { label: 'fast mode', value: 'on' },
        { label: 'queue', value: '1 条 · 已暂停' },
      ]),
    });

    const context = formatMobileSystemCard('context', buildMobileSystemCardData('context', {
      contextUsage: {
        totalTokens: 12000,
        rawMaxTokens: 200000,
        percentage: 6,
        model: 'claude-sonnet-4-6',
        categories: [{ name: 'Messages', tokens: 6000 }],
      },
      session: session(),
    }));
    expect(context.body).toBe('12,000 / 200,000 tokens · 6%');
    expect(context.rows).toEqual([
      { label: 'model', value: 'claude-sonnet-4-6' },
      { label: 'Messages', value: '6,000 tokens · 3.0%' },
    ]);
  });

  it('formats desktop compact and command result cards without adding local commands', () => {
    expect(parseMobileLocalSystemCommand('/cmd')).toBeNull();
    expect(parseMobileLocalSystemCommand('/compact')).toBeNull();

    expect(formatMobileSystemCard('compact', {
      detail: 'Compacted 20 messages',
    })).toEqual({
      title: 'Compact',
      rows: [],
      body: 'Compacted 20 messages',
    });

    expect(formatMobileSystemCard('cmd', {
      command: '/context',
      output: 'Context ok',
    })).toEqual({
      title: 'Command Result',
      rows: [{ label: 'command', value: '/context' }],
      body: 'Context ok',
    });
  });

  it('keeps SDK and other projected values out of the actual-spend wording', () => {
    const sdkData = buildMobileSystemCardData('cost', {
      session: session({
        totalCostUsd: 0.42,
        totalMoney: {
          amount: 0.42,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['sdk-estimate'],
        },
      }),
    });
    expect(formatMobileSystemCard('cost', sdkData).title).toBe(
      i18n.t('message.systemCard.sdkEstimateTitle'),
    );

    const referenceData = buildMobileSystemCardData('cost', {
      session: session({
        totalCostUsd: 0.18,
        totalMoney: {
          amount: 0.18,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['reference-price'],
        },
      }),
    });
    expect(formatMobileSystemCard('cost', referenceData).title).toBe(
      i18n.t('message.systemCard.estimatedValueTitle'),
    );
  });
});

describe('formatMobileSystemCard — goal 续跑卡按原因分说法', () => {
  it('过载续跑说「正在重试目标」, 不说「用量已恢复」', () => {
    // 上游过载那条只是干等了 60s、没有任何容量探测; 报「用量已恢复」是假信息, 而
    // 桌面端已经区分开了, 手机端不跟上就会两端说法矛盾(review #844 codex P1)。
    const capacity = formatMobileSystemCard('goal-resumed', { kind: 'capacity-resumed' });
    expect(capacity.title).toBe(i18n.t('message.systemCard.goalCapacityRetry'));
    expect(capacity.title).not.toBe(i18n.t('message.systemCard.goalResumed'));
  });

  it('账号限流续跑仍说「用量已恢复」(重置时刻有账号额度依据)', () => {
    expect(formatMobileSystemCard('goal-resumed', { kind: 'usage-resumed' }).title).toBe(
      i18n.t('message.systemCard.goalResumed'),
    );
    // data 缺失 / 旧记录没有 kind → 沿用原文案。
    expect(formatMobileSystemCard('goal-resumed', undefined).title).toBe(
      i18n.t('message.systemCard.goalResumed'),
    );
  });
});

describe('formatMobileSystemCard — 中断自动重连状态', () => {
  const info = { error: 'socket hang up', attempt: 2, maxAttempts: 5, sessionTotal: 3 };
  it('shows live progress, reason, current attempt, and session total', () => {
    expect(formatMobileSystemCard('auto-resume', { ...info, live: true })).toMatchObject({
      title: 'Reconnecting 2/5…',
      subtitle: 'Attempt 2/5 · 3 reconnects in this session',
      body: 'socket hang up',
    });
  });
  it('uses persisted outcome while keeping silent-stop records on their original copy', () => {
    expect(['succeeded', 'failed', undefined].map((outcome) =>
      formatMobileSystemCard('auto-resume', outcome ? { ...info, outcome } : {}).title,
    )).toEqual(['Reconnected', 'Reconnect failed', 'Connection interrupted — resumed automatically']);
  });
});

describe('formatMobileSystemCard — Agent 切换', () => {
  it('keeps Pi distinct from Claude Code in persisted switch cards', () => {
    expect(formatMobileSystemCard('agent-switch', {
      fromAgentKind: 'pi',
      toAgentKind: 'codex',
      toModel: 'gpt-5.6',
    }).title).toContain('Pi');
  });
});

describe('commandNeedsRemoteSession', () => {
  // 新建会话的几秒窗口里 composer 全程可用(本 PR 的目的),于是用户可以在会话还没
  // 在被控端建成时发出 slash 命令。要远端的必须挡住(执行只会消费草稿再糊错误卡,
  // 而排队不成立——outbox 的派发动作是 enqueue 一条消息,命令原样入队 agent 会当
  // 普通文本忽略);纯本地卡不该挡,挡了反而破坏「一切正常」的观感。review P1。
  it('只有真正要打被控端的本地命令算(/context)', () => {
    expect(commandNeedsRemoteSession('context', null)).toBe(true);
    for (const name of ['help', 'cost', 'pwd', 'status'] as const) {
      expect(commandNeedsRemoteSession(name, null), name).toBe(false);
    }
  });

  it('desktop 命令一律算(手机端白名单只有 /learn,它就是打被控端的)', () => {
    expect(commandNeedsRemoteSession(null, { name: 'learn' })).toBe(true);
    // 同名 agent-skill 让行时 parse 会返回 null,那条路是普通消息,走 outbox。
    expect(commandNeedsRemoteSession(null, null)).toBe(false);
  });

  it('本地命令清单新增项必须显式归类(防止漏挡)', () => {
    // 这条是清单守卫:以后往 DEFAULT_LOCAL_SYSTEM_COMMANDS 里加命令时,如果它要打
    // 被控端却忘了进 MOBILE_REMOTE_BACKED_LOCAL_COMMANDS,至少这里会提醒有新成员。
    expect(MOBILE_LOCAL_SYSTEM_COMMANDS.map((command) => command.name).sort())
      .toEqual(['context', 'cost', 'help', 'pwd', 'status']);
  });
});
