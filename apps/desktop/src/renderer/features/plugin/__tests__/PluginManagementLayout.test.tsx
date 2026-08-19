/**
 * Regression coverage for the shared Plugin and Skill shell, search accessibility, and focus order.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

function ActiveMainView() {
  return <output data-testid="active-main-view">{useActiveMainView().activeKey}</output>;
}

describe('PluginManagementLayout', () => {
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

    const searchInput = screen.getByRole('textbox', { name: 'Search skills' });
    const searchControl = searchInput.parentElement;
    const searchLabel = searchControl?.querySelector(
      'label[for="plugin-management-skills-search"]',
    );

    expect(searchControl?.getAttribute('data-expanded')).toBeNull();
    expect(searchLabel).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search skills' })).toBeNull();
    searchInput.focus();
    await waitFor(() => expect(document.activeElement).toBe(searchInput));

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(document.activeElement).not.toBe(searchInput);
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

  it('matches DOM focus order to the stacked visual rows', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe() {
          this.callback(
            [{ contentRect: { width: 700 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }

        unobserve() {}
        disconnect() {}
      },
    );

    const { container } = render(
      <MemoryRouter>
        <PluginManagementLayout
          activeTab="plugins"
          query=""
          onQueryChange={vi.fn()}
          headerActions={<button type="button">Add plugin</button>}
        >
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const focusable = [...container.querySelectorAll('input, button')];
      expect(
        focusable.indexOf(screen.getByRole('textbox', { name: 'Search plugins' })),
      ).toBeLessThan(focusable.indexOf(screen.getByRole('tab', { name: 'Plugins' })));
      expect(focusable.indexOf(screen.getByRole('button', { name: 'Add plugin' }))).toBeLessThan(
        focusable.indexOf(screen.getByRole('tab', { name: 'Plugins' })),
      );
    });
  });

  it('preserves focused controls while reordering rows across the stacked breakpoint', async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe() {
          resizeCallback?.(
            [{ contentRect: { width: 800 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }

        unobserve() {}
        disconnect() {}
      },
    );

    render(
      <MemoryRouter>
        <PluginManagementLayout
          activeTab="plugins"
          query=""
          onQueryChange={vi.fn()}
          headerActions={<button type="button">Add plugin</button>}
        >
          <span>Content</span>
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const search = screen.getByRole('textbox', { name: 'Search plugins' });
    search.focus();
    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 700 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByRole('textbox', { name: 'Search plugins' })).toBe(search);

    const pluginsTab = screen.getByRole('tab', { name: 'Plugins' });
    pluginsTab.focus();
    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 800 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    await waitFor(() => expect(document.activeElement).toBe(pluginsTab));
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBe(pluginsTab);
  });
});
