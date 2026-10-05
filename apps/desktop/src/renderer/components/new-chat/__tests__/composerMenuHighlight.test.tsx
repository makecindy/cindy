// @vitest-environment jsdom

/**
 * Composer panels on the shared menu look (DESIGN §4 Composer dropdown rows): the / and @
 * lists keep focus in the editor and drive the glide highlight from their focused index,
 * and MorphPopover keeps its container-transform motion while ending on the shared menu
 * surface. jsdom has no layout, so these cover the target row, focus and styles only.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MENU_CURRENT_ROW_ATTR,
  attachMenuHighlight,
  currentMarkedRow,
} from '@/components/ui/dropdown-menu-highlight';
import { MORPH_MENU_SURFACE, MorphPopover } from '@/components/ui/morph-popover';
import type { UnifiedCommand } from '@/lib/slashCommands';

import { SlashCommandPalette } from '../SlashCommandPalette';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  setReducedMotion(false);
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMMANDS = ['plan', 'review', 'goal'].map(
  (name) => ({ name, kind: 'agent-skill', description: '' }) as unknown as UnifiedCommand,
);

/** Editor stand-in: owns the focused index and moves it with the arrow keys, like ChatInput. */
function SlashHarness() {
  const [focused, setFocused] = useState(0);
  return (
    <div>
      <textarea
        aria-label="editor"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') setFocused((i) => (i + 1) % COMMANDS.length);
          if (event.key === 'ArrowUp')
            setFocused((i) => (i - 1 + COMMANDS.length) % COMMANDS.length);
        }}
      />
      <SlashCommandPalette
        commands={COMMANDS}
        query=""
        focusedIndex={focused}
        onFocusedIndexChange={setFocused}
        onSelect={() => {}}
        onClose={() => {}}
      />
    </div>
  );
}

// The highlight re-reads the current row from a MutationObserver (a microtask).
async function press(target: Element, key: string) {
  await act(async () => {
    fireEvent.keyDown(target, { key });
    await Promise.resolve();
  });
}

const panelOf = (el: Element) => el.closest<HTMLElement>('[data-menu-panel]')!;
const visibleRow = (panel: HTMLElement) => {
  const layer = panel.querySelector<HTMLElement>('[data-menu-highlight-layer]')!;
  return layer.dataset.visible === 'true' ? Number(layer.dataset.row) : -1;
};

describe('composer lists on the shared glide highlight', () => {
  it('keeps focus in the editor while the arrow keys move the highlight', async () => {
    render(<SlashHarness />);
    const editor = screen.getByRole('textbox', { name: 'editor' });
    editor.focus();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-menu-row]'));
    const panel = panelOf(rows[0]);
    expect(rows).toHaveLength(3);
    // One decorative layer, rows without their own fill, the focused row marked current.
    expect(panel.querySelectorAll('[data-menu-highlight-layer]')).toHaveLength(1);
    expect(rows[0].hasAttribute(MENU_CURRENT_ROW_ATTR)).toBe(true);
    expect(rows.every((row) => !/(?:^|\s)(?:hover|focus):bg-|bg-\[var/.test(row.className))).toBe(
      true,
    );
    expect(rows[0].className).toContain('rounded-lg');
    expect(rows[0].className).toContain('text-14');
    // The focused index shows from the start, before any key or pointer input.
    expect(visibleRow(panel)).toBe(0);

    await press(editor, 'ArrowDown');
    expect(rows[1].hasAttribute(MENU_CURRENT_ROW_ATTR)).toBe(true);
    expect(visibleRow(panel)).toBe(1);
    await press(editor, 'ArrowDown');
    expect(visibleRow(panel)).toBe(2);
    await press(editor, 'ArrowUp');
    expect(visibleRow(panel)).toBe(1);
    // The highlight is decoration only: the editor never loses focus to a row.
    expect(document.activeElement).toBe(editor);
    // The row under the layer turns 500 (data-menu-active), like the shared menu rows.
    expect(rows[1].hasAttribute('data-menu-active')).toBe(true);
    expect(rows[1].className).toContain('data-[menu-active]:font-medium');
  });

  it('uses the registered floating-layer shadow on the / panel', () => {
    render(<SlashHarness />);
    const panel = panelOf(document.querySelector('[data-menu-row]')!);
    expect(panel.style.boxShadow).toBe('var(--shadow-menu)');
    expect(panel.className).toContain('bg-[var(--cmd-palette-bg)]');
  });

  it('follows keys pressed outside the panel even while the pointer is inside it', () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-menu-panel', '');
    const layer = document.createElement('span');
    panel.append(layer);
    const rows = [0, 1, 2].map(() => {
      const row = document.createElement('button');
      row.setAttribute('data-menu-row', '');
      panel.append(row);
      return row;
    });
    const editor = document.createElement('textarea');
    document.body.append(panel, editor);
    rows[0].setAttribute(MENU_CURRENT_ROW_ATTR, '');
    const detach = attachMenuHighlight(panel, layer, {
      current: currentMarkedRow,
      currentAttributes: [MENU_CURRENT_ROW_ATTR],
      keyboardSource: document,
    });
    fireEvent.pointerMove(panel, { clientX: 1, clientY: 1 });
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    rows[0].removeAttribute(MENU_CURRENT_ROW_ATTR);
    rows[1].setAttribute(MENU_CURRENT_ROW_ATTR, '');
    return Promise.resolve().then(() => {
      expect(layer.dataset.row).toBe('1');
      expect(rows[1].hasAttribute('data-menu-active')).toBe(true);
      detach();
      panel.remove();
      editor.remove();
    });
  });
});

describe('MorphPopover on the shared menu surface', () => {
  it('keeps the container transform and ends on the menu surface, radius and shadow', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <MorphPopover
          open={open}
          onOpenChange={setOpen}
          panelAriaLabel="Morph panel"
          trigger={
            <button type="button" onClick={() => setOpen(true)}>
              Toggle
            </button>
          }
        >
          <button type="button">Row</button>
        </MorphPopover>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // §14.4 container transform: 220ms, the registered easing, geometry + fill + shadow.
    for (const property of [
      'width',
      'height',
      'top',
      'bottom',
      'border-radius',
      'background-color',
    ]) {
      expect(panel.style.transition).toContain(`${property} 220ms`);
    }
    expect(panel.style.transition).toContain('cubic-bezier(0.3, 0.9, 0.25, 1)');
    expect(panel.style.borderRadius).toBe('12px');
    expect(panel.style.boxShadow).toBe('var(--shadow-menu)');
    expect(panel.style.backgroundColor).toBe(MORPH_MENU_SURFACE);
    expect(panel.style.borderColor).toBe('var(--cmd-palette-border)');
    expect(panel.hasAttribute('data-menu-surface')).toBe(true);
  });
});
