import { describe, expect, it } from 'vitest';

import { VISIBLE_GAMEPAD_FAMILIES, resolveGamepadFamily } from '../xboxGamepad';

describe('visible gamepad accessories', () => {
  it('publishes Xbox and PlayStation only', () => {
    expect([...VISIBLE_GAMEPAD_FAMILIES]).toEqual(['xbox', 'playstation']);
  });
});

describe('resolveGamepadFamily', () => {
  it('trusts an explicit family from the helper', () => {
    expect(resolveGamepadFamily({ family: 'nintendo', name: 'Xbox Wireless Controller' })).toBe(
      'nintendo',
    );
  });

  it('classifies DualSense and DualShock as PlayStation', () => {
    expect(resolveGamepadFamily({ name: 'DualSense Wireless Controller' })).toBe('playstation');
    expect(resolveGamepadFamily({ name: 'Wireless Controller', category: 'DualShock 4' })).toBe(
      'playstation',
    );
    expect(resolveGamepadFamily({ name: 'Sony Interactive Entertainment' })).toBe('playstation');
  });

  it('classifies Switch Pro and Joy-Con as Nintendo', () => {
    expect(resolveGamepadFamily({ name: 'Pro Controller', category: 'Nintendo Switch' })).toBe(
      'nintendo',
    );
    expect(resolveGamepadFamily({ name: 'Joy-Con (L)' })).toBe('nintendo');
  });

  it('keeps Xbox-named pads on the Xbox accessory', () => {
    expect(resolveGamepadFamily({ name: 'Xbox Wireless Controller' })).toBe('xbox');
    expect(resolveGamepadFamily({ name: 'Elite Series 2' })).toBe('xbox');
  });

  it('keeps wired Microsoft Controller pads on the Xbox accessory', () => {
    expect(resolveGamepadFamily({ name: 'Microsoft', category: 'Controller' })).toBe('xbox');
    expect(resolveGamepadFamily({ name: 'Controller' })).toBe('xbox');
  });

  it('defaults unknown extended pads to the generic accessory', () => {
    expect(resolveGamepadFamily({ name: '8BitDo Pro 2' })).toBe('generic');
    expect(resolveGamepadFamily({ name: 'Game Controller' })).toBe('generic');
    expect(resolveGamepadFamily({})).toBe('generic');
  });
});
