/**
 * 哪些失败会自动换电脑(provider-groups.md §6.1)：白名单判定，认不出的一律不换。
 */
import { describe, expect, it } from 'vitest';

import { classifyProviderGroupSwitchCause } from '../switchCause';

describe('classifyProviderGroupSwitchCause', () => {
  it('switches on usage limits, quota and billing depletion', () => {
    expect(classifyProviderGroupSwitchCause({ sdkError: 'rate_limit' })).toBe('usage-limit');
    expect(classifyProviderGroupSwitchCause({ codexErrorInfo: 'usageLimitExceeded' })).toBe('usage-limit');
    expect(classifyProviderGroupSwitchCause({ sdkError: 'billing_error' })).toBe('usage-limit');
  });

  it('switches when the computer is unreachable or its agent stopped', () => {
    expect(classifyProviderGroupSwitchCause({ message: '[REMOTE_AGENT_UNAVAILABLE] remote agent request failed' })).toBe('unavailable');
    expect(classifyProviderGroupSwitchCause({ message: '[REMOTE_AGENT_SHARE_PAUSED] paused' })).toBe('unavailable');
    expect(classifyProviderGroupSwitchCause({ reason: 'remote_agent_closed' })).toBe('unavailable');
  });

  it('switches when that computer is signed out', () => {
    expect(classifyProviderGroupSwitchCause({ sdkError: 'authentication_failed' })).toBe('auth');
    expect(classifyProviderGroupSwitchCause({ errorStatus: 401 })).toBe('auth');
    expect(classifyProviderGroupSwitchCause({ message: 'Invalid API key provided' })).toBe('auth');
  });

  it('switches on overload only after the existing retries gave up', () => {
    expect(classifyProviderGroupSwitchCause({ errorStatus: 529 })).toBe('overload');
  });

  it('does not switch for failures any computer would hit', () => {
    expect(classifyProviderGroupSwitchCause({ sdkError: 'invalid_request', message: 'prompt is too long' })).toBeNull();
    expect(classifyProviderGroupSwitchCause({ message: 'Permission denied by user' })).toBeNull();
    expect(classifyProviderGroupSwitchCause({ reason: 'turn-failed', message: 'Tool execution failed' })).toBeNull();
    expect(classifyProviderGroupSwitchCause(undefined)).toBeNull();
  });
});
