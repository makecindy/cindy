// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { lockMenuWidth } from '../dropdown-menu-highlight';
import * as menuStyles from '@/features/cc-agent/sidebar/menuStyles';
import { MENU_ITEM_CLASS, MENU_ROW_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { SessionProjectMoveSubmenu } from '@/features/cc-agent/sidebar/SessionProjectMoveSubmenu';
import { Pin } from 'lucide-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep CSS source assertions independent of Git's platform-specific checkout line endings.
const globals = readFileSync(resolve(__dirname, '../../../styles/globals.css'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

// jsdom has no layout, so every row reports a zero rect; these tests cover the
// behaviour that does not depend on geometry (target row, layer, a11y); the
// nearest-row test stubs the boxes it needs.
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

function Menu({ onRename, hoverHighlight }: { onRename?: () => void; hoverHighlight?: boolean }) {
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent hoverHighlight={hoverHighlight}>
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Show details</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="focus:bg-[var(--cmd-palette-item-hover)]">
          Custom
        </DropdownMenuItem>
        <DropdownMenuItem variant="danger">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupedMenu() {
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Date</DropdownMenuItem>
        <DropdownMenuItem>Name</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Show in Finder</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menu = () => screen.getByRole('menu');
const layers = () =>
  Array.from(menu().querySelectorAll<HTMLElement>('[data-menu-highlight-layer]'));
const visibleLayer = () => layers().find((l) => l.dataset.visible === 'true');
const rowIndex = (name: string) =>
  Array.from(menu().querySelectorAll('[data-menu-row]')).findIndex((el) => el.textContent === name);

async function key(k: string) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? menu(), { key: k });
    // Radix roving focus moves focus on the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('shared dropdown menu glide highlight', () => {
  it('keeps Radix roles, keyboard navigation and onSelect', async () => {
    const onRename = vi.fn();
    render(<Menu onRename={onRename} />);
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Rename',
      'Duplicate',
      'Custom',
      'Delete',
    ]);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show details' })).toBeTruthy();
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Rename');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Duplicate');
    await key('Home');
    expect(document.activeElement?.textContent).toBe('Rename');
    await key('Enter');
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('follows the Radix highlighted item with one decorative layer per panel', async () => {
    render(<Menu />);
    expect(layers()).toHaveLength(1);
    const [layer] = layers();
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.className).toContain('pointer-events-none');
    await key('ArrowDown');
    expect(visibleLayer()?.dataset.row).toBe(String(rowIndex('Rename')));
    await key('ArrowDown');
    expect(visibleLayer()?.dataset.row).toBe(String(rowIndex('Duplicate')));
  });

  it('keeps gliding the same layer across a separator', async () => {
    render(<GroupedMenu />);
    const [layer] = layers();
    await key('ArrowDown');
    await key('ArrowDown');
    expect(layer.dataset.row).toBe(String(rowIndex('Name')));
    await key('ArrowDown');
    // Separators only group visually: no second layer, no fade-out, still a slide.
    expect(layers()).toEqual([layer]);
    expect(layer.dataset.row).toBe(String(rowIndex('Show in Finder')));
    expect(layer.style.opacity).toBe('1');
    expect(layer.style.transition).toContain('transform');
  });

  it('picks the nearest row anywhere in the panel, including the separator strip', () => {
    render(<GroupedMenu />);
    const panel = menu();
    // Panel 0–110px; rows Date 4–36, Name 36–68, separator 68–77, Show in Finder 77–109.
    const boxes: Record<string, [number, number]> = {
      Date: [4, 36],
      Name: [36, 68],
      'Show in Finder': [77, 109],
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const [top, bottom] = this === panel ? [0, 110] : (boxes[this.textContent ?? ''] ?? [0, 0]);
      return DOMRect.fromRect({ x: 0, y: top, width: 200, height: bottom - top });
    });
    const [layer] = layers();
    const seen: string[] = [];
    for (const y of [50, 66, 70, 72, 75, 80]) {
      fireEvent.pointerMove(panel, { clientX: 100, clientY: y });
      expect(layer.dataset.visible).toBe('true');
      seen.push(layer.dataset.row!);
    }
    const name = String(rowIndex('Name'));
    const finder = String(rowIndex('Show in Finder'));
    expect(seen).toEqual([name, name, name, name, finder, finder]);
    expect(layers()).toEqual([layer]);
  });

  it('drops the per-row focus fill for layer rows and keeps caller highlights as they were', async () => {
    render(<Menu />);
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    const custom = screen.getByRole('menuitem', { name: 'Custom' });
    expect(rename.className).not.toContain('focus:bg-');
    expect(custom.hasAttribute('data-menu-own-highlight')).toBe(true);
    expect(custom.className).toContain('focus:bg-[var(--cmd-palette-item-hover)]');
    await key('End');
    await key('ArrowUp');
    expect(document.activeElement?.textContent).toBe('Custom');
    // No second highlight on top of the caller's own focus background.
    expect(visibleLayer()).toBeUndefined();
  });

  it('can be switched off per panel, restoring per-row focus fills', () => {
    render(<Menu hoverHighlight={false} />);
    expect(layers()).toHaveLength(0);
    expect(screen.getByRole('menuitem', { name: 'Rename' }).className).toContain(
      'focus:bg-sidebar-item-hover',
    );
  });

  it('does not slide under reduced motion', async () => {
    setReducedMotion(true);
    render(<Menu />);
    await key('ArrowDown');
    await key('ArrowDown');
    const layer = visibleLayer()!;
    expect(layer.dataset.row).toBe(String(rowIndex('Duplicate')));
    expect(layer.style.transition).not.toContain('transform');
  });

  it('slides with transform on the motion tokens otherwise', async () => {
    render(<Menu />);
    await key('ArrowDown');
    await key('ArrowDown');
    const transition = visibleLayer()!.style.transition;
    expect(transition).toContain('transform var(--motion-instant)');
    expect(transition).not.toMatch(/\d+ms/);
  });

  it('draws separators in the Board divider colour of the panel border', () => {
    render(<Menu />);
    const separator = menu().querySelector('[role="separator"]')!;
    expect(separator.className).toContain('bg-[var(--cmd-palette-border)]');
    expect(separator.className).not.toContain('bg-muted');
  });

  it('applies the menu text defaults and one danger red', () => {
    render(<Menu />);
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    expect(rename.className).toContain('text-14');
    expect(rename.className).toContain('leading-[1.43]');
    expect(rename.className).toContain('text-[var(--cmd-palette-item-text)]');
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.className).toContain('text-[var(--error-fg)]');
    expect(remove.className).not.toContain('text-[var(--cmd-palette-item-text)]');
  });

  it('keeps one text colour on hover and moves data-menu-active with the highlight', async () => {
    render(<Menu />);
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    // Only the weight changes on hover, not the colour.
    expect(rename.className).not.toContain('--menu-row-text');
    expect(rename.className).not.toContain('text-tertiary');
    expect(rename.className).toContain('duration-[var(--motion-instant)]');
    expect(rename.hasAttribute('data-menu-active')).toBe(false);
    await key('ArrowDown');
    expect(rename.hasAttribute('data-menu-active')).toBe(true);
    await key('ArrowDown');
    expect(rename.hasAttribute('data-menu-active')).toBe(false);
    expect(
      screen.getByRole('menuitem', { name: 'Duplicate' }).hasAttribute('data-menu-active'),
    ).toBe(true);
  });

  it('keeps a caller text colour on rest and highlight alike', () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem className="text-[var(--msg-assistant-text)]">
            Own colour
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const row = screen.getByRole('menuitem', { name: 'Own colour' });
    expect(row.className).toContain('text-[var(--msg-assistant-text)]');
    expect(row.className).not.toContain('text-[var(--cmd-palette-item-text)]');
  });

  it('lets sidebar MENU_ITEM_CLASS rows join the shared glide highlight', async () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem className={MENU_ITEM_CLASS}>Pin</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>Move</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const pin = screen.getByRole('menuitem', { name: 'Pin' });
    const move = screen.getByRole('menuitem', { name: 'Move' });
    for (const row of [pin, move]) {
      expect(row.hasAttribute('data-menu-own-highlight')).toBe(false);
      expect(row.className).not.toMatch(/(?:focus|hover|data-\[state=open\]):bg-/);
      expect(row.className).toContain('text-[var(--cmd-palette-item-text)]');
    }
    await key('ArrowDown');
    expect(visibleLayer()?.dataset.row).toBe(String(rowIndex('Pin')));
  });

  it('turns the active or checked row to 500 while the label reserves its 500 width', async () => {
    render(<Menu />);
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    expect(rename.className).toContain('font-normal');
    for (const state of ['menu-active', 'highlighted', 'state=checked', 'state=open'])
      expect(rename.className).toContain(`data-[${state}]:font-medium`);
    expect(rename.className).toContain('transition-[background-color,font-weight]');
    // The label keeps textContent (typeahead, accessible name) and carries an invisible,
    // zero-height 500-weight copy in ::after that fixes its width.
    expect(rename.textContent).toBe('Rename');
    const label = rename.querySelector<HTMLElement>('[data-menu-label]')!;
    expect(label.dataset.menuLabel).toBe('Rename');
    for (const cls of [
      'inline-flex',
      'flex-col',
      'after:invisible',
      'after:h-0',
      'after:font-medium',
    ])
      expect(label.className).toContain(cls);
    expect(label.className).toContain('after:content-[attr(data-menu-label)_/_""]');
    const checked = screen.getByRole('menuitemcheckbox', { name: 'Show details' });
    expect(checked.getAttribute('data-state')).toBe('checked');
    expect(checked.className).toContain('data-[state=checked]:font-medium');
    // Typeahead still matches the visible label.
    await key('d');
    expect(document.activeElement?.textContent).toBe('Duplicate');
  });

  it('keeps a caller weight and reserves width inside truncating spans too', () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem className="font-semibold">Bold row</DropdownMenuItem>
          <DropdownMenuItem>
            <span className="truncate">Long name</span>
            <span className="flex-1">Nested</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const bold = screen.getByRole('menuitem', { name: 'Bold row' });
    expect(bold.className).toContain('font-semibold');
    expect(bold.className).not.toContain('font-normal');
    expect(bold.className).not.toContain('data-[highlighted]:font-medium');
    const nested = screen
      .getAllByRole('menuitem')
      .find((el) => el.textContent === 'Long nameNested')!;
    // A truncating span keeps its text inline and reserves the 500 width in its own ::after.
    const truncating = nested.querySelector<HTMLElement>('.truncate')!;
    expect(truncating.querySelector('[data-menu-label]')).toBeNull();
    expect(truncating.dataset.menuLabel).toBe('Long name');
    for (const cls of ['after:block', 'after:h-0', 'after:invisible', 'after:font-medium'])
      expect(truncating.className).toContain(cls);
    expect(nested.querySelector('.flex-1 > [data-menu-label]')?.textContent).toBe('Nested');
  });

  it('thins default Lucide strokes at rest but leaves an explicit strokeWidth alone', () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            <Pin size={14} />
            Default icon
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Pin size={14} strokeWidth={2} />
            Explicit icon
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const icon = (name: string) =>
      screen.getByRole('menuitem', { name }).querySelector('svg.lucide')!;
    expect(icon('Default icon').hasAttribute('data-menu-icon-stroke')).toBe(false);
    expect(icon('Default icon').getAttribute('stroke-width')).toBe('2');
    expect(icon('Explicit icon').hasAttribute('data-menu-icon-stroke')).toBe(true);
    // The stroke rule lives in globals.css, scoped to shared rows and default-width icons;
    // non-option blocks (menuSkipAttrs, data-menu-row="skip") keep their stroke.
    expect(globals).toMatch(
      /\[data-menu-row\]:not\(\[data-menu-row='skip'\]\) svg\.lucide\[stroke-width='2'\]:not\(\[data-menu-icon-stroke\]\) \{\s*stroke-width: 1\.5;\s*transition: stroke-width var\(--motion-instant\) var\(--motion-ease-out\);/,
    );
    expect(globals).toMatch(
      /\[data-menu-row\]:is\(\s*\[data-menu-active\],\s*\[data-highlighted\],\s*\[data-state='checked'\],\s*\[data-state='open'\]\s*\)\s*svg\.lucide\[stroke-width='2'\]:not\(\[data-menu-icon-stroke\]\) \{\s*stroke-width: 2;/,
    );
  });

  it('draws shared panels on --cmd-palette-bg, opaque and unblurred on Windows', () => {
    render(<Menu />);
    expect(menu().className).toContain('bg-[var(--cmd-palette-bg)]');
    expect(menu().className).not.toContain('bg-popover');
    const glass = globals.indexOf(
      '.bg-\\[var\\(--cmd-palette-bg\\)\\] {\n  background: var(--surface-translucent-overlay);',
    );
    const win = globals.indexOf(
      "[data-platform='win32'][data-theme='cindy-dark'] .bg-\\[var\\(--cmd-palette-bg\\)\\] {",
    );
    expect(glass).toBeGreaterThan(0);
    // The Windows exception comes after (and is more specific than) the glass rule.
    expect(win).toBeGreaterThan(glass);
    expect(globals.slice(win, win + 200)).toMatch(
      /background: var\(--cmd-palette-bg\);\s*backdrop-filter: none;\s*-webkit-backdrop-filter: none;/,
    );
    expect(globals).toContain(
      "[data-platform='win32'][data-theme='cindy-light'] .bg-\\[var\\(--cmd-palette-bg\\)\\],",
    );
  });

  it('puts the task-move submenu and the conversation search menus on the shared highlight', () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SessionProjectMoveSubmenu
            projectOptions={
              [{ name: 'Cindy', path: '/p/cindy', description: '~/p/cindy' }] as never
            }
            isDialogue={false}
            onSelectProject={() => {}}
            onBrowseProject={() => {}}
            onMoveToDialogue={() => {}}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const rows = Array.from(menu().querySelectorAll<HTMLElement>('[data-menu-row]'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.hasAttribute('data-menu-own-highlight')).toBe(false);
      expect(row.className).not.toContain('cmd-palette-item-hover');
      expect(row.className).toContain('text-[var(--cmd-palette-item-text)]');
    }
    const search = readFileSync(
      resolve(__dirname, '../../../features/cc-agent/sidebar/ConversationSearchBox.tsx'),
      'utf8',
    );
    expect(search).toContain("} from './menuStyles';");
    expect(search).not.toMatch(
      /const (MENU_ROW_CLASS|MENU_ITEM_CLASS|MENU_CONTENT_CLASS|SUB_CONTENT_CLASS) =/,
    );
    expect(search).not.toContain('focus:bg-[var(--cmd-palette-item-hover)]');
  });

  it('keeps the same grey layer under a danger row, by pointer path or keyboard', async () => {
    render(<Menu />);
    const [layer] = layers();
    // No light error fill; only the danger text is red.
    expect(layer.className).toContain('bg-sidebar-item-hover');
    expect(layer.className).not.toContain('error-bg');
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.className).toContain('text-[var(--error-fg)]');
    await key('End');
    expect(layer.dataset.row).toBe(String(rowIndex('Delete')));
    expect(layer.hasAttribute('data-danger')).toBe(false);
    expect(layer.style.transition).not.toContain('background-color');
    expect(remove.className).toContain('data-[highlighted]:font-medium');
  });

  it('locks the panel width once laid out and re-measures on content or window changes', async () => {
    const panel = document.createElement('div');
    document.body.append(panel);
    let natural = '203.4px';
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (el: Element) =>
        ({
          width: el === panel ? (panel.style.width ? panel.style.width : natural) : '',
        }) as CSSStyleDeclaration,
    );
    const release = lockMenuWidth(panel);
    expect(panel.style.width).toBe('203.4px');
    // Hover never re-measures: attribute / style changes on rows are ignored.
    natural = '205px';
    panel.setAttribute('data-anything', '1');
    expect(panel.style.width).toBe('203.4px');
    // Rows or text changing re-measure from the natural width.
    const row = document.createElement('div');
    panel.append(row);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.style.width).toBe('205px');
    natural = '190px';
    window.dispatchEvent(new Event('resize'));
    expect(panel.style.width).toBe('190px');
    release();
    expect(panel.style.width).toBe('');
    // A caller-set inline width stays in charge.
    panel.style.width = '300px';
    lockMenuWidth(panel)();
    expect(panel.style.width).toBe('300px');
    spy.mockRestore();
    panel.remove();
  });

  it('gives sidebar panels the working registered shadow from the shared default', () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent className="w-[248px]">
          <DropdownMenuItem className={MENU_ITEM_CLASS}>Row</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    // Sidebar menus pass only a width now; the untyped shadow-[var(--shadow-menu)] (a
    // Tailwind shadow colour, no shadow) can no longer replace the shared default.
    const cls = menu().className;
    expect(cls).toContain('shadow-[shadow:var(--shadow-menu)]');
    expect(cls).not.toContain('shadow-[var(--shadow-menu)]');
    for (const token of [
      'w-[248px]',
      'bg-[var(--cmd-palette-bg)]',
      'border-[var(--cmd-palette-border)]',
      'text-[var(--cmd-palette-item-text)]',
    ])
      expect(cls).toContain(token);
    expect(Object.keys(menuStyles).sort()).toEqual(['MENU_ITEM_CLASS', 'MENU_ROW_CLASS']);
  });

  it('coalesces pointer moves into one update per frame and caches row geometry lookups', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <div data-scroll="" style={{ overflowY: 'auto' }}>
            <DropdownMenuItem>Date</DropdownMenuItem>
            <DropdownMenuItem>Name</DropdownMenuItem>
            <DropdownMenuItem>Show in Finder</DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const panel = menu();
    const boxes: Record<string, [number, number]> = {
      Date: [4, 36],
      Name: [36, 68],
      'Show in Finder': [77, 109],
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const [top, bottom] =
        this === panel || this.hasAttribute('data-scroll')
          ? [0, 110]
          : (boxes[this.textContent ?? ''] ?? [0, 0]);
      return DOMRect.fromRect({ x: 0, y: top, width: 200, height: bottom - top });
    });
    const flush = () => frames.splice(0).forEach((cb) => cb(0));
    flush();
    const [layer] = layers();
    const styles = vi.spyOn(window, 'getComputedStyle');
    for (const y of [10, 20, 30, 40, 50])
      fireEvent.pointerMove(panel, { clientX: 100, clientY: y });
    // Five moves inside one frame schedule a single update.
    expect(frames).toHaveLength(1);
    flush();
    expect(layer.dataset.row).toBe(String(rowIndex('Name')));
    // Computed-style reads of the rows' clipping-ancestor candidates (inside the panel).
    const ancestorReads = () =>
      styles.mock.calls.filter(
        ([el]) =>
          el !== panel &&
          panel.contains(el as Node) &&
          !(el as Element).hasAttribute('data-menu-row'),
      ).length;
    const firstFrame = ancestorReads();
    expect(firstFrame).toBeGreaterThan(0);
    for (const y of [80, 90, 100]) fireEvent.pointerMove(panel, { clientX: 100, clientY: y });
    flush();
    expect(layer.dataset.row).toBe(String(rowIndex('Show in Finder')));
    // Clipping ancestors are cached: later frames read no computed styles.
    expect(ancestorReads()).toBe(firstFrame);
  });
});
