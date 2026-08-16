import { describe, expect, it, vi } from 'vitest';

import {
  measureComposerStackTopOffset,
  resolveMessageStreamIndicatorBottomOffset,
} from '../messageStreamIndicatorPosition';

describe('resolveMessageStreamIndicatorBottomOffset', () => {
  it('keeps the indicator anchored to the composer when the status row changes overlay height', () => {
    expect(
      resolveMessageStreamIndicatorBottomOffset({
        bottomPadding: 174,
        composerStackTopOffset: 142,
      }),
    ).toBe(148);
    expect(
      resolveMessageStreamIndicatorBottomOffset({
        bottomPadding: 206,
        composerStackTopOffset: 142,
      }),
    ).toBe(148);
  });

  it('preserves the legacy offset when the composer stack cannot be measured', () => {
    expect(resolveMessageStreamIndicatorBottomOffset({ bottomPadding: 174 })).toBe(118);
    expect(resolveMessageStreamIndicatorBottomOffset({ bottomPadding: 40 })).toBe(12);
  });

  it('measures from the outer composer stack so goal and plan indicators stay above the button', () => {
    const composerStack = {
      getBoundingClientRect: () => ({ top: 620 }),
    } as HTMLElement;
    const querySelector = vi.fn((selector: string) =>
      selector === '[data-chat-composer-stack]' ? composerStack : null,
    );
    const overlay = {
      querySelector,
      getBoundingClientRect: () => ({ bottom: 800 }),
    } as unknown as HTMLElement;

    expect(measureComposerStackTopOffset(overlay)).toBe(180);
    expect(querySelector).toHaveBeenCalledWith('[data-chat-composer-stack]');
  });
});
