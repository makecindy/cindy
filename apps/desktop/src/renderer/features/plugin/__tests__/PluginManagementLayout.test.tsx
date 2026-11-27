/**
 * Regression coverage for the shared Plugin and Skill shell, catalog headings, and focus order.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.ghosts.title': 'Plugins',
        'settings.ghosts.page.search': 'Search plugins',
        'settings.ghosts.page.clearSearch': 'Clear Plugin Search',
        'skillhub.home.title': 'Skills',
        'sidebar.horizontalTabbarAria': 'Plugin and skill navigation',
        'skillhub.home.search': 'Search skills',
        'skillhub.home.clearSearch': 'Clear skill search',
      })[key] ?? key,
  }),
}));

import {
  CatalogHeading,
  CatalogHeadingTabs,
  PLUGIN_INSTALLED_CARD_GRID_CLASS,
  PLUGIN_MANAGEMENT_CONTENT_CONTAINER_CLASS,
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from '../PluginManagementLayout';
import { useActiveMainView } from '@/hooks/useActiveMainView';

afterEach(() => {
  vi.unstubAllGlobals();
});

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

function observeCatalogWidth(initialWidth: number) {
  let notify: (width: number) => void = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      notify = width => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    observe() { notify(initialWidth); }
    disconnect() {}
  });
  return (width: number) => act(() => notify(width));
}

function ActiveMainView() {
  return <output data-testid="active-main-view">{useActiveMainView().activeKey}</output>;
}

function ActiveMainViewNavigationProbe() {
  const navigate = useNavigate();
  return (
    <>
      <ActiveMainView />
      <button type="button" onClick={() => navigate('/apps/workspace')}>
        Open main view
      </button>
    </>
  );
}

describe('PluginManagementLayout', () => {
  // Unit, round2 SPEC §1 (G): search replaces the underlined tabs in the accessibility tree
  // while the same heading and device control remain mounted in their row.
  it('retains the heading and device control while hiding catalog tabs during search', () => {
    const anchor = createRef<HTMLDivElement>();
    const select = vi.fn();
    const view = (searching: boolean) => (
      <main>
        <CatalogHeading
          anchor={anchor}
          title={searching ? 'Search results' : 'Installed'}
          searching={searching}
          target={<button type="button">Current computer</button>}
          tabs={<CatalogHeadingTabs value="installed" installedCount={15} marketCount={93} onValueChange={select} />}
        />
      </main>
    );
    const { rerender } = render(view(false));
    const heading = screen.getByRole('heading', { level: 1, name: 'Installed' });
    const target = screen.getByRole('button', { name: 'Current computer' });
    const tablist = screen.getByRole('tablist');
    const installed = screen.getByRole('tab', { name: /installedSection.*15/ });
    const market = screen.getByRole('tab', { name: /marketSection.*93/ });
    expect(installed.getAttribute('aria-selected')).toBe('true');
    expect(tablist.style.getPropertyValue('--segmented-option-height')).toBe('44px');
    fireEvent.keyDown(installed, { key: 'ArrowRight' });
    expect(select).toHaveBeenCalledWith('market');
    expect(document.activeElement).toBe(market);

    rerender(view(true));
    expect(screen.getByRole('heading', { level: 1, name: 'Search results' })).toBe(heading);
    expect(heading.closest('header')).toBe(tablist.closest('header'));
    expect(screen.getByRole('button', { name: 'Current computer' })).toBe(target);
    expect(screen.queryByRole('tablist')).toBeNull();

    rerender(view(false));
    expect(screen.getByRole('tab', { name: /installedSection.*15/ })).toBe(installed);
  });

  it('presents Plugins and Skills as peer tabs and navigates to the skill home', async () => {
    render(
      <MemoryRouter initialEntries={['/plugins']}>
        <PluginManagementLayout activeTab="plugins">
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Skills' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByRole('tab', { name: 'SkillHub' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    await waitFor(() => {
      expect(screen.getByTestId('current-path').textContent).toBe('/skillhub/local');
    });
  });

  it('keeps Plugins / Skills inside Settings when onSelectTab is provided', () => {
    const onSelectTab = vi.fn();
    render(
      <MemoryRouter initialEntries={['/settings?tab=ghosts']}>
        <PluginManagementLayout activeTab="plugins" embedded onSelectTab={onSelectTab}>
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    expect(onSelectTab).toHaveBeenCalledWith('skills');
    expect(screen.getByTestId('current-path').textContent).toBe('/settings');
  });

  it('keeps the Plugin sidebar view active for a direct Skill deep link', () => {
    render(
      <MemoryRouter initialEntries={['/skillhub/local/skill/global/example']}>
        <ActiveMainView />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('active-main-view').textContent).toBe('plugins');
  });

  it('clears the sticky Plugin active state when entering a plugin main view', async () => {
    render(
      <MemoryRouter initialEntries={['/plugins']}>
        <ActiveMainViewNavigationProbe />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('active-main-view').textContent).toBe('plugins');
    fireEvent.click(screen.getByRole('button', { name: 'Open main view' }));
    await waitFor(() => {
      expect(screen.getByTestId('active-main-view').textContent).toBe('');
    });
  });

  it('uses the same constrained frame for the tab row and page content', () => {
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="skills">
          <PluginManagementPage>
            <span data-testid="page-content">Content</span>
          </PluginManagementPage>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const tabFrame = screen.getByRole('tablist').parentElement;
    const pageFrame = screen.getByTestId('page-content').parentElement;
    expect(tabFrame?.className).toContain('max-w-[920px]');
    expect(tabFrame?.parentElement?.className).toContain('px-3');
    expect(pageFrame?.className).toContain('max-w-[920px]');
    expect(pageFrame?.className).toContain(PLUGIN_MANAGEMENT_CONTENT_CONTAINER_CLASS);
  });

  it('uses a content-width responsive card grid for both catalogs', () => {
    expect(PLUGIN_MANAGEMENT_CARD_GRID_CLASS).toContain('auto-fit');
    expect(PLUGIN_MANAGEMENT_CARD_GRID_CLASS).toContain('min(100%,22.5rem)');
    expect(PLUGIN_MANAGEMENT_CARD_GRID_CLASS).not.toMatch(/\b(?:sm|md|lg):grid-cols-/);
  });

  it('keeps a lone installed card on one of the two catalog tracks', () => {
    expect(PLUGIN_INSTALLED_CARD_GRID_CLASS).toContain('grid-cols-2');
    expect(PLUGIN_INSTALLED_CARD_GRID_CLASS).not.toContain('auto-fit');
  });

  it('keeps catalog children in a height-constrained flex column so their main area can scroll', () => {
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="plugins">
          <main data-testid="scroll-region" className="min-h-0 flex-1 overflow-y-auto" />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const contentFrame = screen.getByTestId('scroll-region').parentElement;
    expect(contentFrame?.className).toContain('flex');
    expect(contentFrame?.className).toContain('min-h-0');
    expect(contentFrame?.className).toContain('flex-1');
    expect(contentFrame?.className).toContain('flex-col');
  });

  it('renders the same shared search control for either management tab', () => {
    const onQueryChange = vi.fn();
    render(
      <MemoryRouter>
        <PluginManagementLayout
          activeTab="skills"
          query="mivo"
          onQueryChange={onQueryChange}
          searchPlaceholder="Search skills"
          clearSearchLabel="Clear skill search"
        >
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const search = screen.getByRole('textbox', { name: 'Search skills' });
    expect((search as HTMLInputElement).value).toBe('mivo');

    fireEvent.change(search, { target: { value: 'calendar' } });
    expect(onQueryChange).toHaveBeenCalledWith('calendar');

    fireEvent.click(screen.getByRole('button', { name: 'Clear skill search' }));
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it.each([
    ['plugins', 'Search plugins', 'Clear Plugin Search'],
    ['skills', 'Search skills', 'Clear skill search'],
  ] as const)(
    'provides accessible search defaults for the %s tab',
    (activeTab, searchLabel, clearLabel) => {
      render(
        <MemoryRouter>
          <PluginManagementLayout activeTab={activeTab} query="calendar" onQueryChange={vi.fn()}>
            <span>Content</span>
          </PluginManagementLayout>
        </MemoryRouter>,
      );

      expect(screen.getByRole('textbox', { name: searchLabel })).toBeTruthy();
      expect(screen.getByRole('button', { name: clearLabel })).toBeTruthy();
    },
  );

  // Unit: activating the clear control sends an empty query and returns focus to the search field.
  it('clears plugin search and restores input focus from the clear button', () => {
    const onQueryChange = vi.fn();
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="plugins" query="calendar" onQueryChange={onQueryChange}>
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );
    const clear = screen.getByRole('button', { name: 'Clear Plugin Search' });
    act(() => clear.focus());
    expect(document.activeElement).toBe(clear);
    fireEvent.click(clear);
    expect(onQueryChange).toHaveBeenCalledWith('');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search plugins' }));
  });

  it('keeps search directly editable and blurs an empty search with Escape', async () => {
    render(
      <MemoryRouter>
        <PluginManagementLayout
          activeTab="skills"
          query=""
          onQueryChange={vi.fn()}
          searchPlaceholder="Search skills"
          clearSearchLabel="Clear skill search"
        >
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const searchInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search skills' });
    const searchLabel = searchInput.labels?.[0];
    const searchControl = searchLabel?.parentElement;

    expect(searchControl?.getAttribute('data-expanded')).toBeNull();
    expect(searchLabel).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search skills' })).toBeNull();
    searchInput.focus();
    await waitFor(() => expect(document.activeElement).toBe(searchInput));

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(document.activeElement).not.toBe(searchInput);
  });

  it('ignores a held Escape auto-repeat so one press clears without also blurring', () => {
    const onQueryChange = vi.fn();
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="skills" query="calendar" onQueryChange={onQueryChange}>
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const searchInput = screen.getByRole('textbox', { name: 'Search skills' });
    searchInput.focus();
    const repeat = new KeyboardEvent('keydown', {
      key: 'Escape',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      searchInput.dispatchEvent(repeat);
    });

    expect(onQueryChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(searchInput);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it('leaves the search query and focus intact when IME handles Escape', () => {
    const onQueryChange = vi.fn();
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="skills" query="calendar" onQueryChange={onQueryChange}>
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const searchInput = screen.getByRole('textbox', { name: 'Search skills' });
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: 'Escape', isComposing: true });

    expect(onQueryChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(searchInput);
  });

  it.each([
    ['plugins', 720, false],
    ['skills', 720, true],
    ['skills', 721, false],
  ] as const)('keeps the %s focus order at a content width of %d', (activeTab, width, searchFirst) => {
    observeCatalogWidth(width);
    const { container } = render(
      <MemoryRouter>
        <PluginManagementLayout
          activeTab={activeTab}
          query=""
          onQueryChange={vi.fn()}
          headerActions={<button type="button">Add</button>}
        >
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const focusable = [...container.querySelectorAll<HTMLElement>('input, button')];
    const search = screen.getByRole(activeTab === 'plugins' ? 'button' : 'textbox', {
      name: activeTab === 'plugins' ? 'Search plugins' : 'Search skills',
    });
    const tab = screen.getByRole('tab', { name: activeTab === 'skills' ? 'Skills' : 'Plugins' });
    const action = screen.getByRole('button', { name: 'Add' });
    const expected = searchFirst ? [search, action, tab] : [tab, search, action];
    expect(focusable.filter(control => expected.includes(control))).toEqual(expected);
    if (activeTab === 'skills') expect(screen.queryByRole('button', { name: 'Search skills' })).toBeNull();
  });

  it('keeps the wide tab position and focused search control when switching catalogs', () => {
    observeCatalogWidth(900);
    const view = (activeTab: 'plugins' | 'skills') => (
      <MemoryRouter>
        <PluginManagementLayout
          activeTab={activeTab}
          query=""
          onQueryChange={vi.fn()}
          headerActions={<button type="button">Add plugin</button>}
        >
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>
    );
    const { rerender } = render(view('plugins'));
    const tabs = screen.getByRole('tablist');
    const tabFrame = tabs.parentElement;
    fireEvent.click(screen.getByRole('button', { name: 'Search plugins' }));
    const search = screen.getByRole('textbox', { name: 'Search plugins' });
    expect(document.activeElement).toBe(search);
    rerender(view('skills'));
    expect(tabFrame?.firstElementChild).toBe(tabs);
    expect(screen.getByRole('tablist')).toBe(tabs);
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole('textbox', { name: 'Search skills' })).toBe(search);
  });

  it('preserves a focused skill input and tab across the stacked breakpoint', () => {
    const resize = observeCatalogWidth(800);
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="skills" query="" onQueryChange={vi.fn()}>
          <span>Skills content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );
    const search = screen.getByRole('textbox', { name: 'Search skills' });
    act(() => search.focus());
    resize(700);
    expect(document.activeElement).toBe(search);
    const tab = screen.getByRole('tab', { name: 'Skills' });
    act(() => tab.focus());
    resize(800);
    expect(document.activeElement).toBe(tab);
  });

  it('opens the plugin search input and collapses it after Escape when empty', () => {
    render(
      <MemoryRouter>
        <PluginManagementLayout activeTab="plugins" query="" onQueryChange={vi.fn()}>
          <span>Plugins</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );
    const name = 'Search plugins';
    expect(screen.queryByRole('textbox', { name })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name }));
    const search = screen.getByRole('textbox', { name });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name })).toBeNull();
  });
});
