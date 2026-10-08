import { describe, expect, it } from 'vitest';
import {
  botGroupComposerPlanState,
  botGroupErrorVariant,
  botGroupNoticeVariant,
  botGroupPlanFollowUp,
  isBotGroupDivisionBlocked,
} from '../botGroupPresentation.js';
import type { BotGroupErrorCode, BotGroupNoticeCode, BotGroupPlanView } from '../botGroupChat.js';

const plan = (overrides: Partial<BotGroupPlanView> = {}): BotGroupPlanView => ({
  id: 'p1', status: 'waiting', organizerBotId: 'a', organizerName: 'A', currentStep: 0, workDir: null, branch: null,
  createdAt: 1, updatedAt: 1,
  steps: [
    { position: 0, botId: 'a', botName: 'A', task: 'one', status: 'done' },
    { position: 1, botId: 'b', botName: 'B', task: 'two', status: 'pending' },
  ],
  ...overrides,
});

describe('bot group copy variants (shared by desktop and phone)', () => {
  it('speaks about a step for member notices inside a plan', () => {
    expect(botGroupNoticeVariant('member-joined', false)).toBe('memberJoined');
    expect(botGroupNoticeVariant('member-failed', false)).toBe('memberFailed');
    expect(botGroupNoticeVariant('member-failed', true)).toBe('stepFailed');
    expect(botGroupNoticeVariant('plan-stopped', true)).toBe('planStopped');
    expect(botGroupNoticeVariant(null, true)).toBeNull();
    // Untrusted codes from a newer host fall back to the message text.
    expect(botGroupNoticeVariant('toString' as BotGroupNoticeCode, false)).toBeNull();
  });

  it('names only the refusals the user can act on', () => {
    expect(botGroupErrorVariant('PLAN_OPEN')).toBe('planOpen');
    expect(botGroupErrorVariant('INTERNAL')).toBeNull();
    expect(botGroupErrorVariant('constructor' as BotGroupErrorCode)).toBeNull();
    expect(botGroupErrorVariant(undefined)).toBeNull();
  });
});

describe('plan follow-up and composer state', () => {
  it('offers the next step after a finished one and a retry after a failed one', () => {
    expect(botGroupPlanFollowUp(plan())).toEqual({ kind: 'continue', next: plan().steps[1] });
    const failed = plan({ steps: [{ ...plan().steps[0]!, status: 'failed' }, plan().steps[1]!] });
    expect(botGroupPlanFollowUp(failed)).toEqual({ kind: 'retry', failed: failed.steps[0] });
    expect(botGroupPlanFollowUp(plan({ status: 'running' }))).toBeNull();
  });

  it('blocks a new 安排分工 while a plan runs or waits', () => {
    expect(isBotGroupDivisionBlocked(botGroupComposerPlanState(plan()))).toBe(true);
    expect(isBotGroupDivisionBlocked(botGroupComposerPlanState(plan({ status: 'proposed' })))).toBe(false);
    expect(botGroupComposerPlanState(plan())).toEqual({ kind: 'waiting', botName: 'A', stepDone: true });
  });
});
