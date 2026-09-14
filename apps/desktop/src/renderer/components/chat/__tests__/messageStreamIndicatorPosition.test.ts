import { describe, expect, it, vi } from 'vitest';

import {
  getMessageStreamIndicatorResizeTargets,
  measureMessageStreamIndicatorClearanceOffset,
  resolveMessageStreamIndicatorBottomOffset,
} from '../messageStreamIndicatorPosition';

describe('resolveMessageStreamIndicatorBottomOffset', () => {
  it('keeps the indicator anchored to the composer when the status row changes overlay height', () => {
    expect(
      resolveMessageStreamIndicatorBottomOffset({
        bottomPadding: 174,
        bottomCenterClearanceOffset: 142,
      }),
    ).toBe(148);
    expect(
      resolveMessageStreamIndicatorBottomOffset({
        bottomPadding: 206,
        bottomCenterClearanceOffset: 142,
      }),
    ).toBe(148);
  });

  it('preserves the legacy offset when the composer stack cannot be measured', () => {
    expect(resolveMessageStreamIndicatorBottomOffset({ bottomPadding: 174 })).toBe(118);
    expect(resolveMessageStreamIndicatorBottomOffset({ bottomPadding: 40 })).toBe(12);
  });

  it('uses the composer stack when the center lane is empty', () => {
    const composerStack = {
      getBoundingClientRect: () => ({ top: 620 }),
    } as HTMLElement;
    const centerGroup = {
      childElementCount: 0,
      getBoundingClientRect: () => ({ top: 580, height: 0 }),
    } as HTMLElement;
    const querySelector = vi.fn((selector: string) => {
      if (selector === '[data-chat-composer-stack]') return composerStack;
      if (selector === '[data-composer-center-group]') return centerGroup;
      return null;
    });
    const overlay = {
      querySelector,
      getBoundingClientRect: () => ({ bottom: 800 }),
    } as unknown as HTMLElement;

    expect(measureMessageStreamIndicatorClearanceOffset(overlay)).toBe(180);
    expect(querySelector).toHaveBeenCalledWith('[data-chat-composer-stack]');
    expect(querySelector).toHaveBeenCalledWith('[data-composer-center-group]');
  });

  it('stacks the indicator above an occupied composer center group', () => {
    const composerStack = {
      getBoundingClientRect: () => ({ top: 620 }),
    } as HTMLElement;
    const centerGroup = {
      childElementCount: 1,
      getBoundingClientRect: () => ({ top: 580, height: 32 }),
    } as HTMLElement;
    const overlay = {
      querySelector: (selector: string) =>
        selector === '[data-chat-composer-stack]'
          ? composerStack
          : selector === '[data-composer-center-group]'
            ? centerGroup
            : null,
      getBoundingClientRect: () => ({ bottom: 800 }),
    } as unknown as HTMLElement;

    const clearanceOffset = measureMessageStreamIndicatorClearanceOffset(overlay);
    expect(clearanceOffset).toBe(220);
    const indicatorBottomOffset = resolveMessageStreamIndicatorBottomOffset({
      bottomPadding: 206,
      bottomCenterClearanceOffset: clearanceOffset,
    });
    expect(indicatorBottomOffset).toBe(226);
    expect(580 - (800 - indicatorBottomOffset)).toBe(6);
  });

  it('stacks the indicator above an expanded plan flyout', () => {
    const composerStack = {
      getBoundingClientRect: () => ({ top: 620 }),
    } as HTMLElement;
    const centerGroup = {
      childElementCount: 1,
      getBoundingClientRect: () => ({ top: 580, height: 32 }),
    } as HTMLElement;
    const planFlyout = {
      getBoundingClientRect: () => ({ top: 300, height: 272 }),
    } as HTMLElement;
    const overlay = {
      querySelector: (selector: string) =>
        selector === '[data-chat-composer-stack]'
          ? composerStack
          : selector === '[data-composer-center-group]'
            ? centerGroup
            : selector === '[data-plan-flyout-positioner="composer"]'
              ? planFlyout
              : null,
      getBoundingClientRect: () => ({ bottom: 800 }),
    } as unknown as HTMLElement;

    const clearanceOffset = measureMessageStreamIndicatorClearanceOffset(overlay);
    expect(clearanceOffset).toBe(500);
    const indicatorBottomOffset = resolveMessageStreamIndicatorBottomOffset({
      bottomPadding: 206,
      bottomCenterClearanceOffset: clearanceOffset,
    });
    expect(indicatorBottomOffset).toBe(506);
    expect(300 - (800 - indicatorBottomOffset)).toBe(6);
  });

  it('observes the inner center lane because it can resize without changing the overlay', () => {
    const composerStack = {} as HTMLElement;
    const centerGroup = {} as HTMLElement;
    const planFlyout = {} as HTMLElement;
    const overlay = {
      querySelector: (selector: string) =>
        selector === '[data-chat-composer-stack]'
          ? composerStack
          : selector === '[data-composer-center-group]'
            ? centerGroup
            : selector === '[data-plan-flyout-positioner="composer"]'
              ? planFlyout
              : null,
    } as unknown as HTMLElement;

    expect(getMessageStreamIndicatorResizeTargets(overlay)).toEqual([
      overlay,
      composerStack,
      centerGroup,
      planFlyout,
    ]);
  });
});
