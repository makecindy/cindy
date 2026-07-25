/**
 * Regression coverage for the shared Plugin and Skill management shell.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.ghosts.title': 'Plugins',
        'skillhub.home.title': 'Skills',
        'sidebar.horizontalTabbarAria': 'Plugin and skill navigation',
        'skillhub.home.search': 'Search skills',
        'skillhub.home.clearSearch': 'Clear skill search',
      })[key] ?? key,
  }),
}));

import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from '../PluginManagementLayout';
import { useActiveMainView } from '@/hooks/useActiveMainView';

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
  });

  it('uses a content-width responsive card grid for both catalogs', () => {
    expect(PLUGIN_MANAGEMENT_CARD_GRID_CLASS).toContain('auto-fit');
    expect(PLUGIN_MANAGEMENT_CARD_GRID_CLASS).toContain('min(100%,22.5rem)');
    expect(PLUGIN_MANAGEMENT_CARD_GRID_CLASS).not.toMatch(/\b(?:sm|md|lg):grid-cols-/);
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
});
