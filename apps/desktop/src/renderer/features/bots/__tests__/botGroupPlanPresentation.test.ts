import { describe, expect, it } from 'vitest';

import {
  botGroupComposerPlanState,
  botGroupErrorKey,
  botGroupNoticeKey,
  botGroupPathBasename,
  botGroupPlanFilePath,
  botGroupPlanFollowUp,
  botGroupSidebarPlanPreview,
  isBotGroupDivisionBlocked,
  mergeBotGroupPlans,
  openBotGroupPlan,
} from '../botGroupPresentation';
import type { BotGroupOpenPlanSummary, BotGroupPlanView, BotGroupSummary } from '../../../../shared/botGroupChat';

function plan(overrides: Partial<BotGroupPlanView> = {}): BotGroupPlanView {
  return {
    id: 'p1',
    status: 'waiting',
    organizerBotId: 'mimi',
    organizerName: '咪咪',
    steps: [
      { position: 0, botId: 'mimi', botName: '咪咪', task: '想清楚讲什么', status: 'done' },
      { position: 1, botId: 'xiaoman', botName: '小满', task: '画设计稿', status: 'pending' },
      { position: 2, botId: 'abu', botName: '阿布', task: '写代码', status: 'pending' },
    ],
    currentStep: 0,
    workDir: '/work/site',
    branch: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function openPlan(overrides: Partial<BotGroupOpenPlanSummary> = {}): BotGroupOpenPlanSummary {
  return {
    id: 'p1',
    status: 'waiting',
    currentStep: 0,
    stepCount: 3,
    currentBotName: '咪咪',
    currentStepStatus: 'done',
    ...overrides,
  };
}

function summary(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: 'g1',
    name: '官网',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    organizerBotId: 'xiaoman',
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('分工 presentation', () => {
  it('offers 继续 with the next pending step, and 重试 for a failed one', () => {
    expect(botGroupPlanFollowUp(plan())).toEqual({ kind: 'continue', next: plan().steps[1] });
    const failed = plan({
      currentStep: 1,
      steps: plan().steps.map((step, index) => (index === 1 ? { ...step, status: 'failed' as const } : step)),
    });
    expect(botGroupPlanFollowUp(failed)).toMatchObject({ kind: 'retry', failed: { position: 1 } });
    // Nothing to offer while running, before 开始, or after the last step.
    expect(botGroupPlanFollowUp(plan({ status: 'running' }))).toBeNull();
    expect(botGroupPlanFollowUp(plan({ status: 'proposed', currentStep: null }))).toBeNull();
    expect(
      botGroupPlanFollowUp(
        plan({ currentStep: 2, steps: plan().steps.map((step) => ({ ...step, status: 'done' as const })) }),
      ),
    ).toBeNull();
    expect(botGroupPlanFollowUp(null)).toBeNull();
  });

  it('finds the open plan only when main still reports it open', () => {
    const plans = [plan({ id: 'old', status: 'superseded' }), plan()];
    expect(openBotGroupPlan({ openPlan: openPlan(), plans })?.id).toBe('p1');
    expect(openBotGroupPlan({ openPlan: null, plans })).toBeNull();
    expect(openBotGroupPlan({ openPlan: openPlan({ id: 'old', status: 'proposed' }), plans })).toBeNull();
    expect(mergeBotGroupPlans([plan({ status: 'running' })], [plan({ status: 'waiting' })])).toEqual([plan()]);
  });

  it('follows the open plan in the composer and gates 安排分工 while it is under way', () => {
    expect(botGroupComposerPlanState(plan({ status: 'proposed', currentStep: null }))).toEqual({ kind: 'proposed' });
    expect(botGroupComposerPlanState(plan({ status: 'running', currentStep: 1 }))).toEqual({
      kind: 'running',
      botName: '小满',
    });
    expect(botGroupComposerPlanState(plan())).toEqual({ kind: 'waiting', botName: '咪咪', stepDone: true });
    expect(botGroupComposerPlanState(plan({ status: 'done' }))).toBeNull();
    expect(isBotGroupDivisionBlocked({ kind: 'proposed' })).toBe(false);
    expect(isBotGroupDivisionBlocked({ kind: 'running', botName: '' })).toBe(true);
    expect(isBotGroupDivisionBlocked({ kind: 'waiting', botName: '', stepDone: false })).toBe(true);
    expect(isBotGroupDivisionBlocked(null)).toBe(false);
  });

  it('keeps hand-off files inside the plan work directory', () => {
    expect(botGroupPlanFilePath('/work/site', 'docs/a.md')).toBe('/work/site/docs/a.md');
    expect(botGroupPlanFilePath('/work/site/', 'a.md')).toBe('/work/site/a.md');
    expect(botGroupPlanFilePath('C:\\work\\site', 'docs/a.md')).toBe('C:\\work\\site\\docs\\a.md');
    for (const escape of ['../a.md', 'docs/../../a.md', '/etc/passwd', 'C:/x.md', 'docs\\a.md', './a.md', 'a//b']) {
      expect(botGroupPlanFilePath('/work/site', escape)).toBeNull();
    }
    expect(botGroupPlanFilePath(null, 'a.md')).toBeNull();
    expect(botGroupPathBasename('/Users/me/cindy-site/')).toBe('cindy-site');
    expect(botGroupPathBasename('C:\\code\\site')).toBe('site');
  });

  it('words notices inside a plan as step notices and maps plan errors', () => {
    expect(botGroupNoticeKey('member-failed', false)).toBe('bots.groupChat.notice.memberFailed');
    expect(botGroupNoticeKey('member-failed', true)).toBe('bots.groupChat.notice.stepFailed');
    expect(botGroupNoticeKey('plan-failed', false)).toBe('bots.groupChat.notice.planFailed');
    expect(botGroupNoticeKey('workdir-unavailable', true)).toBe('bots.groupChat.notice.workdirUnavailable');
    expect(botGroupNoticeKey(null, false)).toBeNull();
    expect(botGroupErrorKey('PLAN_OPEN', 'fallback')).toBe('bots.groupChat.errors.planOpen');
    expect(botGroupErrorKey('PLAN_CLOSED', 'fallback')).toBe('bots.groupChat.errors.planClosed');
  });

  it('previews the plan in the sidebar from the list summary', () => {
    expect(botGroupSidebarPlanPreview(summary())).toBeNull();
    expect(
      botGroupSidebarPlanPreview(summary({ openPlan: openPlan({ status: 'proposed', currentStep: null }) })),
    ).toEqual({ kind: 'proposed', organizerName: '小满' });
    expect(
      botGroupSidebarPlanPreview(
        summary({ openPlan: openPlan({ status: 'running', currentStep: 1, currentBotName: '小满' }) }),
      ),
    ).toEqual({ kind: 'running', botName: '小满', step: 2, total: 3 });
    expect(botGroupSidebarPlanPreview(summary({ openPlan: openPlan() }))).toEqual({
      kind: 'step-done',
      botName: '咪咪',
    });
    expect(
      botGroupSidebarPlanPreview(summary({ openPlan: openPlan({ currentStepStatus: 'failed' }) })),
    ).toEqual({ kind: 'step-failed', botName: '咪咪' });
    expect(
      botGroupSidebarPlanPreview(summary({ openPlan: openPlan({ currentBotName: null, currentStepStatus: null }) })),
    ).toEqual({ kind: 'waiting' });
    // The organizer working out a plan wins over the plan it may be revising.
    expect(
      botGroupSidebarPlanPreview(
        summary({ planningBotId: 'mimi', openPlan: openPlan({ status: 'proposed', currentStep: null }) }),
      ),
    ).toEqual({ kind: 'planning', botName: '咪咪' });
  });
});
