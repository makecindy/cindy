import { describe, expect, it } from 'vitest';

import { shouldPrefetchSessionOnPointerDown } from '../sessionSwitchPrefetch';

const primaryPointer = {
  pointerType: 'mouse',
  button: 0,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
} as const;

describe('shouldPrefetchSessionOnPointerDown', () => {
  it('accepts an unmodified primary pointer on an inactive row', () => {
    expect(
      shouldPrefetchSessionOnPointerDown(primaryPointer, {
        isActive: false,
        isEditing: false,
      }),
    ).toBe(true);
  });

  it.each([
    ['active row', { isActive: true, isEditing: false }],
    ['editing row', { isActive: false, isEditing: true }],
  ])('skips %s', (_label, opts) => {
    expect(shouldPrefetchSessionOnPointerDown(primaryPointer, opts)).toBe(false);
  });

  it.each([
    ['secondary pointer', { pointerType: 'mouse', button: 2, shiftKey: false, metaKey: false, ctrlKey: false }],
    ['touch pointer', { pointerType: 'touch', button: 0, shiftKey: false, metaKey: false, ctrlKey: false }],
    ['shift selection', { pointerType: 'mouse', button: 0, shiftKey: true, metaKey: false, ctrlKey: false }],
    ['command selection', { pointerType: 'mouse', button: 0, shiftKey: false, metaKey: true, ctrlKey: false }],
    ['control selection', { pointerType: 'mouse', button: 0, shiftKey: false, metaKey: false, ctrlKey: true }],
  ])('skips %s', (_label, event) => {
    expect(
      shouldPrefetchSessionOnPointerDown(event, { isActive: false, isEditing: false }),
    ).toBe(false);
  });
});
