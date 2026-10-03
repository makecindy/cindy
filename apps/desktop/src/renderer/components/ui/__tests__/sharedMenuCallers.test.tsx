// @vitest-environment jsdom

/**
 * Menus moved from hand-written panels / raw Radix onto the shared DropdownMenu
 * (DESIGN §4 Select & Dropdown). Each one is opened, chosen from by keyboard, and its
 * callback arguments match what the hand-written version passed.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VersionDropdown } from '@/components/UpdateNoticeDialog';
import { TabStrip } from '@/features/right-sidebar/TabBar';
import { AudiencePicker, PublisherPicker } from '@/features/skillhub/components/TeamScopePicker';

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
  function renderStrip(onAdd = vi.fn()) {
    render(
      <TabStrip
        tabs={[{ id: 't1', kind: 'file-browser', title: '', state: {} } as never]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onAdd={onAdd}
      />,
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

  it('closes on Escape without adding a tab', async () => {
    const { add, onAdd } = renderStrip();
    await openByKeyboard(add);
    await key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe('publish to market · team and audience', () => {
  const teams = [
    { slug: 'design', name: 'Design' },
    { slug: 'infra', name: 'Infra' },
  ] as never[];

  it('picks the publishing team by keyboard and closes', async () => {
    const onChange = vi.fn();
    render(
      <PublisherPicker
        mode="team"
        ownerTeamSlug="design"
        deptIds={['d1']}
        deptNames={['Platform dept']}
        teams={teams}
        onChange={onChange}
      />,
    );
    await openByKeyboard(screen.getByRole('button', { name: 'Design' }));
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    await chooseByKeyboard(2);
    expect(onChange).toHaveBeenCalledWith({ mode: 'team', ownerTeamSlug: 'infra' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toggles several audiences without closing and keeps the owner locked', async () => {
    function Harness({ onChange }: { onChange: (value: unknown) => void }) {
      const [value, setValue] = useState({
        visibleDeptIds: [] as string[],
        sharedTeamSlugs: [] as string[],
      });
      return (
        <AudiencePicker
          value={value}
          deptIds={['d1']}
          deptNames={['Platform dept']}
          teams={teams}
          lockedOwnerSlug="design"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openByKeyboard(screen.getByRole('button', { name: /Design/ }));
    const owner = screen.getByRole('menuitemcheckbox', { name: /Design/ });
    expect(owner.getAttribute('aria-checked')).toBe('true');
    expect(owner.hasAttribute('data-disabled')).toBe(true);

    // Focus starts on the first enabled row (Platform dept); tick it, then Infra.
    await key('Enter');
    expect(onChange).toHaveBeenLastCalledWith({ visibleDeptIds: ['d1'], sharedTeamSlugs: [] });
    expect(screen.getByRole('menu')).toBeTruthy();
    await chooseByKeyboard(1);
    expect(onChange).toHaveBeenLastCalledWith({
      visibleDeptIds: ['d1'],
      sharedTeamSlugs: ['infra'],
    });
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Infra' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();

    await key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
