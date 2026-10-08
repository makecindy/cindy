// @vitest-environment jsdom

import { createElement } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserMessageAutoCollapse } from '../userMessageCollapse';

let observers: Array<{ callback: () => void; disconnected: boolean }> = [];
let mirrorHeight = 0;
let heightReads = 0;

function Probe({ content }: { content: string }) {
  const { mirrorRef, shouldCollapse } = useUserMessageAutoCollapse(content, true, 3);
  return createElement('div', { 'data-collapsed': String(shouldCollapse) },
    createElement('div', { ref: mirrorRef, style: { lineHeight: '10px' } }, content));
}

const collapsed = (container: HTMLElement) =>
  container.querySelector('[data-collapsed]')?.getAttribute('data-collapsed');

describe('useUserMessageAutoCollapse measurement reuse', () => {
  beforeEach(() => {
    observers = [];
    heightReads = 0;
    vi.stubGlobal('ResizeObserver', class {
      private readonly entry: { callback: () => void; disconnected: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
      }
      observe() {}
      disconnect() { this.entry.disconnected = true; }
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
      heightReads += 1;
      return mirrorHeight;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('measures new content synchronously, then reuses the result on remount', () => {
    const content = `reuse-${Math.random()}`;
    mirrorHeight = 50; // 5 lines > threshold 3
    const first = render(createElement(Probe, { content }));
    expect(heightReads).toBe(1);
    expect(collapsed(first.container)).toBe('true');
    first.unmount();

    heightReads = 0;
    const second = render(createElement(Probe, { content }));
    // Remount starts from the remembered result without forcing layout.
    expect(heightReads).toBe(0);
    expect(collapsed(second.container)).toBe('true');

    // The observer still re-measures after layout and corrects a width change.
    mirrorHeight = 20;
    act(() => {
      for (const observer of observers) if (!observer.disconnected) observer.callback();
    });
    expect(heightReads).toBe(1);
    expect(collapsed(second.container)).toBe('false');
    second.unmount();

    heightReads = 0;
    const third = render(createElement(Probe, { content }));
    expect(heightReads).toBe(0);
    expect(collapsed(third.container)).toBe('false');
    third.unmount();
  });

  it('does not retain very long bodies; they are measured on every mount', () => {
    const content = `long-${Math.random()}-${'x'.repeat(70_000)}`;
    mirrorHeight = 50;
    render(createElement(Probe, { content })).unmount();
    heightReads = 0;
    render(createElement(Probe, { content })).unmount();
    expect(heightReads).toBe(1);
  });
});
