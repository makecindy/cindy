// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getVisibleSidebarSessionIds } from '@/features/cc-agent/lib/sessionRemovalNavigation';
import { observeSidebarTaskChanges } from '@/features/cc-agent/lib/sidebarTaskObserver';

describe('sidebar task observation', () => {
  let root: HTMLElement;
  let aside: HTMLElement;
  let content: HTMLElement;
  let chat: HTMLElement;
  let disconnect: (() => void) | undefined;
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    document.body.innerHTML = `
      <style>.invisible { visibility: hidden; opacity: 0; }</style>
      <div>
        <aside aria-hidden="false"><div id="content"><div id="sidebar">
          <div id="expanded" hidden>
            <div data-sidebar-session-row="true" data-session-id="expanded"></div>
          </div>
          <div id="rail">
            <div data-sidebar-session-row="true" data-session-id="rail-b" data-sidebar-row-order="1"></div>
            <div data-sidebar-session-row="true" data-session-id="rail-a" data-sidebar-row-order="0"></div>
          </div>
        </div></div></aside>
        <main id="chat"></main>
      </div>`;
    root = document.getElementById('sidebar')!;
    aside = document.querySelector('aside')!;
    content = document.getElementById('content')!;
    chat = document.getElementById('chat')!;
    frameId = 0;
    frames = new Map();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    disconnect?.();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  async function flushFrame() {
    // Deliver the real MutationObserver microtask before the next animation frame.
    await Promise.resolve();
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }

  function watchVisibleRows() {
    const published: string[][] = [];
    const publish = vi.fn(() => published.push(getVisibleSidebarSessionIds()));
    publish();
    disconnect = observeSidebarTaskChanges(root, publish);
    return { publish, published };
  }

  function finishTransition(target: HTMLElement, propertyName: string) {
    const event = new Event('transitionend', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: propertyName });
    target.dispatchEvent(event);
  }

  it('clears and restores rail order when only the outer sidebar shell is hidden', async () => {
    const { publish, published } = watchVisibleRows();
    expect(published).toEqual([['rail-a', 'rail-b']]);
    const unchangedRail = root.innerHTML;

    aside.setAttribute('aria-hidden', 'true');
    content.className = 'invisible';
    await flushFrame();
    expect(published.at(-1)).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(2);

    aside.setAttribute('aria-hidden', 'false');
    content.className = '';
    await flushFrame();
    expect(published.at(-1)).toEqual(['rail-a', 'rail-b']);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(root.innerHTML).toBe(unchangedRail);
  });

  it('still observes expanded/rail switches and merges mutations into one frame', async () => {
    const { publish, published } = watchVisibleRows();
    document.getElementById('expanded')!.hidden = false;
    document.getElementById('rail')!.hidden = true;
    await flushFrame();
    expect(published.at(-1)).toEqual(['expanded']);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('publishes final ancestor fade visibility without another class mutation', async () => {
    const { publish, published } = watchVisibleRows();
    // jsdom has no CSS animations; model the final computed opacity separately
    // from class changes. Inline style is intentionally outside the observer filter.
    content.style.opacity = '0';
    await flushFrame();
    expect(publish).toHaveBeenCalledTimes(1);
    finishTransition(content, 'opacity');
    finishTransition(content, 'visibility');
    await flushFrame();
    expect(published.at(-1)).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(2);

    content.style.opacity = '1';
    finishTransition(content, 'opacity');
    await flushFrame();
    expect(published.at(-1)).toEqual(['rail-a', 'rail-b']);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('does not schedule publishing for streamed chat changes or unrelated body children', async () => {
    const { publish } = watchVisibleRows();
    for (let i = 0; i < 100; i += 1) {
      chat.append(document.createElement('span'));
      chat.className = `stream-${i}`;
    }
    finishTransition(chat, 'opacity');
    finishTransition(root.querySelector<HTMLElement>('[data-session-id]')!, 'opacity');
    finishTransition(content, 'width');
    document.body.append(document.createElement('div'));
    await flushFrame();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('publishes portal mount, content changes and removal including an empty final list', async () => {
    content.className = 'invisible';
    const { published } = watchVisibleRows();
    const portal = document.createElement('div');
    portal.innerHTML = `<div data-rail-panel>
      <div data-sidebar-session-row="true" data-session-id="portal"></div>
    </div>`;
    document.body.append(portal);
    await flushFrame();
    expect(published.at(-1)).toEqual(['portal']);

    portal.querySelector<HTMLElement>('[data-session-id]')!.hidden = true;
    await flushFrame();
    expect(published.at(-1)).toEqual([]);
    portal.querySelector<HTMLElement>('[data-session-id]')!.hidden = false;
    await flushFrame();
    expect(published.at(-1)).toEqual(['portal']);

    portal.remove();
    await flushFrame();
    expect(published).toEqual([[], ['portal'], [], ['portal'], []]);
  });

  it('disconnects observers and cancels a pending publish on teardown', async () => {
    const { publish } = watchVisibleRows();
    root.append(document.createElement('div'));
    await Promise.resolve();
    expect(frames.size).toBe(1);
    disconnect!();
    root.append(document.createElement('div'));
    content.className = 'invisible';
    finishTransition(content, 'opacity');
    await flushFrame();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
});
