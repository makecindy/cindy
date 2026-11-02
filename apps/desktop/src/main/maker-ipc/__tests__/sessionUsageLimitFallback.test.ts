import { describe, expect, it } from 'vitest';

import {
  isConfirmedUsageLimit,
  matchesUsageLimitFallbackSource,
  usageLimitFallbackLabels,
  type SessionUsageLimitFallback,
} from '../sessionUsageLimitFallback.js';
import type { SessionRuntimeProfile } from '../sessionRuntimeControl.js';

const codexRoute: SessionRuntimeProfile = {
  agentKind: 'codex',
  model: 'gpt-6.1-sol',
  providerId: 'chatgpt',
  effort: 'medium',
  fastMode: false,
  agentDeviceId: null,
};

const policy: SessionUsageLimitFallback = {
  source: codexRoute,
  target: { providerId: 'xd', model: 'deepseek-v4-flash' },
};

describe('isConfirmedUsageLimit', () => {
  it('accepts the structured account-exhaustion signals', () => {
    expect(isConfirmedUsageLimit({ codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
    expect(isConfirmedUsageLimit({ usageResetAt: Date.parse('2026-10-29T02:40:00.000Z') })).toBe(true);
  });

  it('needs the message itself to be account exhaustion when only the text flag is set', () => {
    // usageLimit 位由文案正则置位，`rate limit` / `too many requests` 也会置。
    expect(
      isConfirmedUsageLimit({
        usageLimit: true,
        message: "You've hit your usage limit. Upgrade to Pro or try again at 7:40 PM.",
      }),
    ).toBe(true);
    expect(
      isConfirmedUsageLimit({ usageLimit: true, message: 'rate limit reached, too many requests' }),
    ).toBe(false);
    expect(isConfirmedUsageLimit({ usageLimit: true })).toBe(false);
  });

  it('rejects ordinary rate limits and transient failures', () => {
    expect(isConfirmedUsageLimit({ errorStatus: 429, reason: 'rate-limit' })).toBe(false);
    expect(isConfirmedUsageLimit({ reason: 'upstream-overload' })).toBe(false);
    expect(isConfirmedUsageLimit({})).toBe(false);
  });

  it('rejects auth and billing failures even when they look like quota exhaustion', () => {
    expect(isConfirmedUsageLimit({ usageLimit: true, errorStatus: 401 })).toBe(false);
    expect(isConfirmedUsageLimit({ usageLimit: true, errorStatus: 403 })).toBe(false);
    expect(isConfirmedUsageLimit({ usageResetAt: 1, sdkError: 'billing_error' })).toBe(false);
    expect(isConfirmedUsageLimit({ codexErrorInfo: 'usageLimitExceeded', sdkError: 'authentication_error' })).toBe(false);
  });
});

describe('matchesUsageLimitFallbackSource', () => {
  it('only fires while the task still runs the configured route', () => {
    expect(matchesUsageLimitFallbackSource(policy, { ...codexRoute })).toBe(true);
    expect(matchesUsageLimitFallbackSource(policy, { ...codexRoute, model: 'gpt-6.1-mini' })).toBe(false);
    expect(matchesUsageLimitFallbackSource(policy, { ...codexRoute, providerId: 'openai' })).toBe(false);
    expect(matchesUsageLimitFallbackSource(policy, { ...codexRoute, agentKind: 'claude-code' })).toBe(false);
  });

  it('never fires for a task whose agent runs on another computer', () => {
    expect(
      matchesUsageLimitFallbackSource(policy, { ...codexRoute, agentDeviceId: 'remote-device' }),
    ).toBe(false);
  });

  it('does not fire again after the switch, so a task cannot loop back', () => {
    const switched: SessionRuntimeProfile = {
      ...codexRoute,
      model: policy.target.model,
      providerId: policy.target.providerId,
    };
    expect(matchesUsageLimitFallbackSource(policy, switched)).toBe(false);
  });
});

describe('usageLimitFallbackLabels', () => {
  it('names both routes for the activity line', () => {
    expect(usageLimitFallbackLabels(policy)).toEqual({
      from: 'gpt-6.1-sol',
      to: 'deepseek-v4-flash',
    });
  });
});
