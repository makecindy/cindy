import { describe, expect, it } from 'vitest';

import {
  deduplicateDefaultPermissionOptions,
  permissionModeOrAsk,
  requiresFullAccessConfirmation,
} from '../permissionMode.js';

describe('permissionModeOrAsk', () => {
  it.each([
    'ask',
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'bypassPermissions',
  ] as const)('preserves the known mode %s', (mode) => {
    expect(permissionModeOrAsk(mode)).toBe(mode);
  });

  it.each([undefined, null, '', 'future-mode', 1, {}])(
    'fails closed for %j',
    (value) => {
      expect(permissionModeOrAsk(value)).toBe('ask');
    },
  );
});

describe('deduplicateDefaultPermissionOptions', () => {
  const ask = { id: 'ask', displayName: 'Default permissions' };
  const legacy = { id: 'default', displayName: 'Default permissions' };
  const plan = { id: 'plan', displayName: 'Plan' };
  const auto = { id: 'auto', displayName: 'Auto' };

  it.each(['ask', 'default'])('retains the selected %s alias regardless of server order', mode => {
    for (const aliases of [[ask, legacy], [legacy, ask]]) {
      const input = [plan, ...aliases, auto];
      expect(deduplicateDefaultPermissionOptions(input, mode)).toEqual([
        plan, mode === 'ask' ? ask : legacy, auto,
      ]);
      expect(input).toHaveLength(4);
    }
  });

  it('prefers ask when neither alias is selected, preserving the other modes', () => {
    expect(deduplicateDefaultPermissionOptions([plan, legacy, ask, auto], 'auto'))
      .toEqual([plan, ask, auto]);
  });

  it('retains a legacy-only host option and its original descriptor', () => {
    expect(deduplicateDefaultPermissionOptions([legacy], 'ask')[0]).toBe(legacy);
    expect(deduplicateDefaultPermissionOptions([], 'ask')).toEqual([]);
  });
});

describe('requiresFullAccessConfirmation', () => {
  it.each(['ask', 'default', 'acceptEdits', 'plan', 'auto', undefined, 'future-mode'])(
    'requires confirmation when entering Full access from %j',
    (currentMode) => {
      expect(requiresFullAccessConfirmation(currentMode, 'bypassPermissions')).toBe(true);
    },
  );

  it('does not ask again while already in Full access', () => {
    expect(requiresFullAccessConfirmation('bypassPermissions', 'bypassPermissions')).toBe(false);
  });

  it('does not ask when switching to a safer mode', () => {
    expect(requiresFullAccessConfirmation('bypassPermissions', 'ask')).toBe(false);
  });
});
