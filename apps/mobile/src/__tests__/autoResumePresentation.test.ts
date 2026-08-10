import { describe, expect, it } from 'vitest';
import {
  canExpandMobileAutoResume,
  getMobileAutoResumePresentation,
  isMobileAutoResumeRowInFlight,
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
