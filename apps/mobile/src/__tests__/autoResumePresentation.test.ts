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

describe('usage-limit reset continuation', () => {
  it('is its own row without reconnect attempt details', () => {
    const presentation = getMobileAutoResumePresentation({
      reason: 'usage-limit-reset',
      error: "You've hit your session limit",
      attempt: 1,
      maxAttempts: 3,
      sessionTotal: 1,
    });
    expect(presentation.info.usageLimitReset).toBe(true);
    expect(presentation.state).toBe('neutral');
    expect(presentation.hasProgress).toBe(false);
    expect(presentation.info.sessionTotal).toBeUndefined();
    expect(presentation.canExpand).toBe(true);
  });
});


describe('provider group computer switch', () => {
  it('reads the switch carried by a desktop auto-continue record', () => {
    expect(readMobileAutoResumeInfo({
      reason: 'usage-limit-reset',
      agentSwitch: { from: 'Mac mini', to: 'Studio-PC', cause: 'auth' },
    })).toEqual({ usageLimitReset: true, agentSwitch: { from: 'Mac mini', to: 'Studio-PC', cause: 'auth' } });
  });

  it('ignores malformed switch data', () => {
    expect(readMobileAutoResumeInfo({ reason: 'usage-limit-reset', agentSwitch: { from: 'A', cause: 'auth' } }))
      .toEqual({ usageLimitReset: true });
  });

  it('reads a shared user’s switch without any computer names', () => {
    expect(readMobileAutoResumeInfo({ reason: 'usage-limit-reset', groupSwitch: { cause: 'usage-limit' } }))
      .toEqual({ usageLimitReset: true, groupSwitch: { cause: 'usage-limit' } });
    expect(readMobileAutoResumeInfo({ reason: 'usage-limit-reset', groupSwitch: {} }))
      .toEqual({ usageLimitReset: true });
  });
});
