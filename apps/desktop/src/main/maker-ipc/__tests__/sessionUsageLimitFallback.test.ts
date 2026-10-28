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
    expect(isConfirmedUsageLimit({ usageLimit: true })).toBe(true);
    expect(isConfirmedUsageLimit({ codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
  });

  it('rejects ordinary rate limits and transient failures', () => {
    expect(isConfirmedUsageLimit({ errorStatus: 429, reason: 'rate-limit' })).toBe(false);
    expect(isConfirmedUsageLimit({ reason: 'upstream-overload' })).toBe(false);
    expect(isConfirmedUsageLimit({})).toBe(false);
  });

  it('rejects auth and billing failures even when they look like quota exhaustion', () => {
    expect(isConfirmedUsageLimit({ usageLimit: true, errorStatus: 401 })).toBe(false);
    expect(isConfirmedUsageLimit({ usageLimit: true, errorStatus: 403 })).toBe(false);
    expect(isConfirmedUsageLimit({ usageLimit: true, sdkError: 'billing_error' })).toBe(false);
    expect(isConfirmedUsageLimit({ usageLimit: true, sdkError: 'authentication_error' })).toBe(false);
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
