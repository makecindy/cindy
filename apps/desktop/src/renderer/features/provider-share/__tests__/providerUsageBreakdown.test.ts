import { describe, expect, it } from 'vitest';

import { deviceIdOfMemberKey, shareAgentDeviceIdOfMemberKey } from '../providerUsageBreakdown';

describe('member keys', () => {
  it('reads the computer out of a group member key', () => {
    expect(deviceIdOfMemberKey('device:studio:anthropic-2')).toBe('studio');
    expect(deviceIdOfMemberKey('local')).toBeNull();
    expect(shareAgentDeviceIdOfMemberKey('share:abc:anthropic')).toBe('share:abc');
    expect(shareAgentDeviceIdOfMemberKey('device:studio:x')).toBeNull();
  });
});
