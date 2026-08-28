import { describe, expect, it } from 'vitest';

import {
  GHOST_RESERVED_PREFIX_GATE_ENV,
  shouldRejectReservedGhostIds,
} from '../reservedGhostIdGate.js';

describe('shouldRejectReservedGhostIds', () => {
  it('does not enable the reserved-prefix gate in dev by default', () => {
    expect(shouldRejectReservedGhostIds(false, undefined)).toBe(false);
  });

  it('enables the reserved-prefix gate in dev for the exact value 1', () => {
    expect(shouldRejectReservedGhostIds(false, '1')).toBe(true);
  });

  // Prevents Boolean(envValue); ` 1`/`1 ` pin the left/right boundaries of exact `1`.
  it.each(['0', '', 'true', 'anything', '01', ' 1', '1 '])(
    'does not enable the dev gate for non-1 value %j',
    (envValue) => {
      expect(shouldRejectReservedGhostIds(false, envValue)).toBe(false);
    },
  );

  it('keeps the reserved-prefix gate enabled in packaged builds by default', () => {
    expect(shouldRejectReservedGhostIds(true, undefined)).toBe(true);
  });

  // Including `1` prevents XOR: packaged !== (envValue === '1') would open production here.
  it.each(['1', '0', '', 'anything', 'true'])(
    'cannot disable the packaged reserved-prefix gate with %j',
    (envValue) => {
      expect(shouldRejectReservedGhostIds(true, envValue)).toBe(true);
    },
  );

  it('reads the environment on every call when no explicit value is supplied', () => {
    const original = process.env[GHOST_RESERVED_PREFIX_GATE_ENV];
    try {
      // This sequence prevents a module-load snapshot from masquerading as a live override.
      delete process.env[GHOST_RESERVED_PREFIX_GATE_ENV];
      expect(shouldRejectReservedGhostIds(false)).toBe(false);
      process.env[GHOST_RESERVED_PREFIX_GATE_ENV] = '1';
      expect(shouldRejectReservedGhostIds(false)).toBe(true);
      process.env[GHOST_RESERVED_PREFIX_GATE_ENV] = '0';
      expect(shouldRejectReservedGhostIds(false)).toBe(false);
    } finally {
      if (original === undefined) delete process.env[GHOST_RESERVED_PREFIX_GATE_ENV];
      else process.env[GHOST_RESERVED_PREFIX_GATE_ENV] = original;
    }
  });
});
