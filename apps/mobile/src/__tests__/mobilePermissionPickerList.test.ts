import { describe, expect, it } from 'vitest';

import { permissionOptionsForDisplay } from '@/session/mobilePermissionPickerOptions';

const fallbackOptions = [
  { id: 'default', label: 'default' },
  { id: 'ask', label: 'ask' },
  { id: 'acceptEdits', label: 'acceptEdits' },
  { id: 'plan', label: 'plan' },
  { id: 'bypassPermissions', label: 'bypassPermissions' },
];

describe('permissionOptionsForDisplay', () => {
  it('合并 default/ask 同义项并隐藏 plan', () => {
    expect(permissionOptionsForDisplay(fallbackOptions, 'ask').map((option) => option.id))
      .toEqual(['ask', 'acceptEdits', 'bypassPermissions']);
  });

  it('当前仍是 legacy default 时保留当前 id', () => {
    expect(permissionOptionsForDisplay(fallbackOptions, 'default')[0]?.id).toBe('default');
  });
});
