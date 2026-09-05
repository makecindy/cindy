// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealQuickSwitcherTarget } from '../features/cc-agent/lib/quickSwitcherReveal';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const rect = new DOMRect(0, 0, 100, 20);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('quick switch sidebar reveal', () => {
  it('waits for mounting and expansion before focusing and scrolling the exact task', async () => {
    cleanups.push(
      revealQuickSwitcherTarget({ kind: 'session', sessionId: 'target', projectKey: 'local:repo' }),
    );
    document.body.innerHTML =
      '<div data-sidebar-section-collapsed="true"><div tabindex="0" data-sidebar-session-row="true" data-session-id="target"></div></div>';
    const section = document.body.firstElementChild!;
    const row = section.firstElementChild!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(row.scrollIntoView).not.toHaveBeenCalled();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(section, 'getAnimations', { value: () => [{ finished }] });
    section.removeAttribute('data-sidebar-section-collapsed');
    await Promise.resolve();
    expect(row.scrollIntoView).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(document.activeElement).toBe(row));
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
  it('targets the project header rather than its potentially tall child list', async () => {
    document.body.innerHTML =
      '<div data-project-workingdir="local:repo"><div tabindex="0" data-project-header="true"></div><div data-sidebar-session-row="true" data-session-id="target"></div></div>';
    const header = document.querySelector('[data-project-header]');
    cleanups.push(
      revealQuickSwitcherTarget({ kind: 'project', sessionId: 'target', projectKey: 'local:repo' }),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(header));
  });
  it('does not steal focus after its navigation has been canceled', async () => {
    const cancel = revealQuickSwitcherTarget({
      kind: 'session',
      sessionId: 'target',
      projectKey: null,
    });
    cancel();
    document.body.innerHTML =
      '<div tabindex="0" data-sidebar-session-row="true" data-session-id="target"></div>';
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
