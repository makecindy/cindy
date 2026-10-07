import { describe, expect, it } from 'vitest';
import {
  CODEX_QUOTA_RESTORED_RESUME_REASON,
  CODEX_RESET_CREDIT_CHECKING_REASON,
  CODEX_RESET_CREDIT_RESUME_REASON,
} from '@cindy/maker-shared/synthetic-trigger';
import {
  canExpandMobileAutoResume,
  getMobileAutoResumePresentation,
  isMobileAutoResumeRowInFlight,
  mobileAutoResumeLabelKey,
  readMobileAutoResumeInfo,
  summarizeMobileInterruption,
  toggleMobileAutoResumeExpanded,
} from '@/session/autoResumePresentation';

describe('autoResumePresentation', () => {
  const info = { error: 'API Error: socket   hang up. Please retry.', attempt: 2, maxAttempts: 5, sessionTotal: 3 };

  it('keeps pending progress live while the continuation owner is in flight', () => {
    expect(getMobileAutoResumePresentation({ ...info, live: true }).state).toBe('live');
    const inFlight = isMobileAutoResumeRowInFlight({
      isContinuationTurnOwner: true,
      makerTurnRunning: true,
      isLastUserInput: false,
      projectionCapability: 'supported',
    });

    expect(getMobileAutoResumePresentation({ ...info }, inFlight).state).toBe('live');
  });

  it('uses the legacy fallback only for a legacy projection', () => {
    const args = {
      isContinuationTurnOwner: false,
      makerTurnRunning: true,
      isLastUserInput: true,
    };
    expect(isMobileAutoResumeRowInFlight({ ...args, projectionCapability: 'legacy' })).toBe(true);
    expect(isMobileAutoResumeRowInFlight({ ...args, projectionCapability: 'supported' })).toBe(false);
    expect(isMobileAutoResumeRowInFlight({ ...args, projectionCapability: 'unknown' })).toBe(false);
  });

  it('lets terminal outcomes win over a stale in-flight signal', () => {
    expect(getMobileAutoResumePresentation({ ...info, outcome: 'succeeded' }, true).state).toBe('succeeded');
    expect(getMobileAutoResumePresentation({ ...info, outcome: 'failed' }, true).state).toBe('failed');
  });

  it('shows a neutral recorded row when there is context but no live or terminal outcome', () => {
    expect(getMobileAutoResumePresentation({ sessionTotal: 3 }).state).toBe('neutral');
    expect(getMobileAutoResumePresentation({}).state).toBe('separator');
  });

  it('normalizes interruption context and keeps expansion bounded to useful detail', () => {
    expect(readMobileAutoResumeInfo({ attempt: 0, maxAttempts: '5', outcome: 'unknown' })).toEqual({});
    expect(summarizeMobileInterruption('  API Error: socket   hang up. Please retry. More detail.  '))
      .toBe('socket hang up.');
    expect(summarizeMobileInterruption(`API Error: ${'x'.repeat(80)}`)).toHaveLength(72);
    expect(canExpandMobileAutoResume(info)).toBe(true);
    expect(canExpandMobileAutoResume({})).toBe(false);
    expect(toggleMobileAutoResumeExpanded(false, true)).toBe(true);
    expect(toggleMobileAutoResumeExpanded(true, true)).toBe(false);
    expect(toggleMobileAutoResumeExpanded(true, false)).toBe(false);
  });
});

describe('Codex quota continuation', () => {
  it('drops reconnect counters and keeps the row expandable to the usage-limit reason', () => {
    const data = {
      reason: CODEX_RESET_CREDIT_RESUME_REASON,
      error: "You've hit your usage limit.",
      attempt: 1,
      maxAttempts: 5,
      sessionTotal: 4,
    };
    expect(readMobileAutoResumeInfo(data)).toEqual({
      quotaKind: 'reset',
      error: "You've hit your usage limit.",
    });
    const presentation = getMobileAutoResumePresentation({ ...data, live: true });
    expect(presentation.state).toBe('live');
    expect(presentation.hasProgress).toBe(false);
  });

  it('is never shown as the silent-stop separator, even without an error text', () => {
    expect(getMobileAutoResumePresentation({ reason: CODEX_RESET_CREDIT_RESUME_REASON }).state)
      .toBe('neutral');
  });

  it('labels checking, using a reset and restored quota, and never calls a failed one continued', () => {
    expect(mobileAutoResumeLabelKey('checking', 'live', false)).toBe('message.systemCard.autoResume.resetCreditChecking');
    expect(mobileAutoResumeLabelKey('reset', 'live', false)).toBe('message.systemCard.autoResume.resetCreditPending');
    expect(mobileAutoResumeLabelKey('reset', 'failed', false)).toBe('message.systemCard.autoResume.resetCreditFailed');
    expect(mobileAutoResumeLabelKey('restored', 'succeeded', false)).toBe('message.systemCard.autoResume.quotaRestoredSucceeded');
    expect(mobileAutoResumeLabelKey(undefined, 'live', true)).toBe('message.systemCard.autoResume.pendingWithProgress');
    expect(mobileAutoResumeLabelKey(undefined, 'neutral', false)).toBe('message.systemCard.autoResume.neutral');
    expect(readMobileAutoResumeInfo({ reason: CODEX_RESET_CREDIT_CHECKING_REASON }).quotaKind).toBe('checking');
    expect(readMobileAutoResumeInfo({ reason: CODEX_QUOTA_RESTORED_RESUME_REASON }).quotaKind).toBe('restored');
  });
});
