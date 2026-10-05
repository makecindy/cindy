// @vitest-environment jsdom

/**
 * Menus moved from hand-written panels / raw Radix onto the shared DropdownMenu
 * (DESIGN §4 Select & Dropdown). Each one is opened, chosen from by keyboard, and its
 * callback arguments match what the hand-written version passed.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VersionDropdown } from '@/components/UpdateNoticeDialog';
import { TabStrip } from '@/features/right-sidebar/TabBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function key(k: string, target: Element = document.activeElement ?? document.body) {
  await act(async () => {
    fireEvent.keyDown(target, { key: k });
    // Radix roving focus moves focus on the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Opens a Radix menu from the keyboard and puts focus on its first enabled row. */
async function openByKeyboard(trigger: HTMLElement) {
  trigger.focus();
  await key('Enter', trigger);
  await key('Home');
}

/** Moves Radix's roving focus down from the current row and activates it. */
async function chooseByKeyboard(steps: number) {
  for (let i = 0; i < steps; i += 1) await key('ArrowDown');
  await key('Enter');
}

describe('update notice · version jump', () => {
  function renderVersions(onSelect = vi.fn()) {
    render(
      <VersionDropdown
        versions={['2.3.0', '2.2.0', '2.1.0']}
        currentVersion="2.2.0"
        onSelect={onSelect}
        triggerLabel="v2.2.0"
        triggerAriaLabel="Jump to version"
      />,
    );
    return onSelect;
  }

  it('marks the version on screen and jumps to the version chosen by keyboard', async () => {
    const onSelect = renderVersions();
    await openByKeyboard(screen.getByRole('button', { name: 'Jump to version' }));
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map((row) => row.textContent)).toEqual(['v2.3.0', 'v2.2.0', 'v2.1.0']);
    expect(rows[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(rows[0]);
    await chooseByKeyboard(2);
    expect(onSelect).toHaveBeenCalledWith('2.1.0');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('still calls onSelect for the version already on screen', async () => {
    const onSelect = renderVersions();
    await openByKeyboard(screen.getByRole('button', { name: 'Jump to version' }));
    await chooseByKeyboard(1);
    expect(onSelect).toHaveBeenCalledWith('2.2.0');
  });
});

describe('right sidebar · add tab', () => {
  function renderStrip(onAdd = vi.fn(), container?: HTMLElement) {
    render(
      <TabStrip
        tabs={[{ id: 't1', kind: 'file-browser', title: '', state: {} } as never]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onAdd={onAdd}
      />,
      container ? { container: container.appendChild(document.createElement('div')) } : undefined,
    );
    const add = screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' });
    // jsdom has no layout; the menu closes itself when its anchor has no size.
    vi.spyOn(add.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(20, 20, 24, 24),
    );
    return { add, onAdd };
  }

  it('adds the tab kind chosen by keyboard, skipping the disabled coming-soon rows', async () => {
    const { add, onAdd } = renderStrip();
    await openByKeyboard(add);
    const menu = screen.getByRole('menu');
    expect(menu.hasAttribute('data-rsb-territory')).toBe(true);
    expect(screen.getAllByRole('menuitem')[0].textContent).toContain(
      'rightSidebar.tabs.kinds.fileBrowser',
    );
    await chooseByKeyboard(1);
    expect(onAdd).toHaveBeenCalledWith('cindy-make');
    expect(screen.queryByRole('menu')).toBeNull();
    // Esc / select returns focus to the "+" button.
    expect(document.activeElement).toBe(add);
  });

  it('closes on Escape without adding a tab and returns focus to "+"', async () => {
    const { add, onAdd } = renderStrip();
    await openByKeyboard(add);
    await key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(add);
  });

  it('closes when the host pane collapses and leaves focus off the hidden "+"', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const pane = document.createElement('div');
    pane.setAttribute('data-panel-drag-root', 'right-tabs');
    document.body.append(pane);
    const { add, onAdd } = renderStrip(vi.fn(), pane);
    await openByKeyboard(add);
    expect(screen.getByRole('menu')).toBeTruthy();
    await act(async () => {
      pane.setAttribute('data-pane-collapsed', '');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(add);
    pane.remove();
  });
});
