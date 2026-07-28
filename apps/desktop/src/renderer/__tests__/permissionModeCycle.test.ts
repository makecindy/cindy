import { describe, expect, it } from 'vitest';

import { getNextPermissionMode } from '../lib/permissionModeCycle';
import type { PermissionModeDescriptor } from '../hooks/useAgentCapabilities';

function descriptors(ids: string[]): PermissionModeDescriptor[] {
  return ids.map((id) => ({ id, displayName: id }));
}

// cc 典型模式列表 (capabilities 返回顺序)
const CC_MODES = descriptors(['ask', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

describe('getNextPermissionMode', () => {
  it('cycles through the full capabilities list in order', () => {
    expect(getNextPermissionMode('ask', CC_MODES)).toBe('acceptEdits');
    expect(getNextPermissionMode('acceptEdits', CC_MODES)).toBe('plan');
    expect(getNextPermissionMode('plan', CC_MODES)).toBe('auto');
    expect(getNextPermissionMode('auto', CC_MODES)).toBe('bypassPermissions');
  });

  it('wraps around from the last mode to the first', () => {
    expect(getNextPermissionMode('bypassPermissions', CC_MODES)).toBe('ask');
  });

  it('falls back to the first option when current mode is not in the list', () => {
    expect(getNextPermissionMode('someUnknownMode', CC_MODES)).toBe('ask');
  });

  it('returns null when there are fewer than two options (key not consumed)', () => {
    expect(getNextPermissionMode('ask', descriptors(['ask']))).toBeNull();
    expect(getNextPermissionMode('ask', [])).toBeNull();
  });

  it('cycles a two-mode list back and forth', () => {
    const two = descriptors(['acceptEdits', 'plan']);
    expect(getNextPermissionMode('acceptEdits', two)).toBe('plan');
    expect(getNextPermissionMode('plan', two)).toBe('acceptEdits');
  });
});
