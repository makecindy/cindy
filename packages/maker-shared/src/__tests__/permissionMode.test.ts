import { describe, expect, it } from 'vitest';

import {
  equivalentPermissionModes,
  isSharedPermissionMode,
  matchSupportedPermissionMode,
  permissionModeOrAsk,
  requiresFullAccessConfirmation,
  resolvePermissionModeForOptions,
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
    expect(isSharedPermissionMode(mode)).toBe(true);
  });

  it.each([undefined, null, '', 'future-mode', 1, {}])(
    'fails closed for %j',
    (value) => {
      expect(permissionModeOrAsk(value)).toBe('ask');
      expect(isSharedPermissionMode(value)).toBe(false);
    },
  );
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

// Unit: cross-harness permission mode recognition (built-in ask <-> agent-published default) and fail-closed fallback.
// Minimum failing input: switching between Claude ('ask') and Antigravity (['default', ..., 'bypassPermissions'])
// or unsupported modes ('acceptEdits' -> Codex ['ask', 'auto', 'bypassPermissions']).
describe('cross-harness permission mode matching and resolution', () => {
  const agyModes = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] as const;
  const codexModes = ['ask', 'auto', 'bypassPermissions'] as const;
  const genericAcpModes = ['ask', 'bypassPermissions'] as const;

  it('recognizes ask and default as equivalent across harnesses', () => {
    expect(equivalentPermissionModes('ask')).toEqual(['ask', 'default']);
    expect(equivalentPermissionModes('default')).toEqual(['default', 'ask']);
    expect(matchSupportedPermissionMode('ask', agyModes)).toBe('default');
    expect(matchSupportedPermissionMode('default', codexModes)).toBe('ask');
    expect(matchSupportedPermissionMode('default', genericAcpModes)).toBe('ask');
  });

  it('preserves supported modes across harnesses and fails closed for unsupported ones', () => {
    expect(resolvePermissionModeForOptions('bypassPermissions', agyModes, 'default')).toBe('bypassPermissions');
    expect(resolvePermissionModeForOptions('auto', agyModes, 'default')).toBe('auto');
    expect(resolvePermissionModeForOptions('acceptEdits', agyModes, 'default')).toBe('acceptEdits');
    expect(resolvePermissionModeForOptions('acceptEdits', codexModes, 'ask')).toBe('ask');
    expect(resolvePermissionModeForOptions('auto', genericAcpModes, 'ask')).toBe('ask');
    expect(resolvePermissionModeForOptions('plan', codexModes, 'ask')).toBe('ask');
    // Never silently widens to bypassPermissions when fallback is missing, unsupported, or itself bypassPermissions.
    expect(resolvePermissionModeForOptions('auto', ['bypassPermissions', 'plan'], null)).toBe('plan');
    expect(resolvePermissionModeForOptions('ask', ['bypassPermissions'], null)).toBe('ask');
    expect(resolvePermissionModeForOptions('plan', ['default', 'bypassPermissions'], 'bypassPermissions')).toBe('default');
    expect(resolvePermissionModeForOptions('auto', ['plan', 'bypassPermissions'], 'bypassPermissions')).toBe('plan');
    expect(resolvePermissionModeForOptions('ask', [], 'bypassPermissions')).toBe('ask');
  });
});
