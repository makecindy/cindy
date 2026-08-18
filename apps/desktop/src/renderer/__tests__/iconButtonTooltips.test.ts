import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function rendererSource(path: string): string {
  return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

describe('icon-only button tooltip coverage', () => {
  it('centralizes visible tips in shared chrome and sidebar button primitives', () => {
    const chromeButton = rendererSource('components/title-bar/ChromeIconButton.tsx');
    const sidebarButton = rendererSource('components/sidebar/SidebarIconButton.tsx');

    expect(chromeButton).toContain("import { Tip, type TipProps } from '@/components/ui/tooltip';");
    expect(chromeButton).toContain('<Tip text={tooltipText}');
    expect(chromeButton).toContain(
      'rest.disabled ? <span className="inline-flex">{button}</span> : button',
    );
    expect(chromeButton).not.toContain('<button type="button" title=');
    expect(sidebarButton).toContain("import { Tip } from '@/components/ui/tooltip';");
    expect(sidebarButton).toContain('<Tip text={title ?? label} side="right">');
    expect(sidebarButton).toContain(
      'disabled ? <span className="inline-flex">{button}</span> : button',
    );
    expect(sidebarButton).not.toContain('title={label}');
  });

  it('gives the left title-bar sidebar toggle and app menu visible tips', () => {
    const chromeActions = rendererSource('components/layout/ChromeActions.tsx');
    const menuButton = rendererSource('components/title-bar/MenuButton.tsx');

    expect(chromeActions).toContain("import { Tip } from '@/components/ui/tooltip';");
    expect(chromeActions).toContain("'contentHeader.expandSidebar'");
    expect(chromeActions).toContain("'contentHeader.collapseSidebar'");
    expect(chromeActions).toContain('<Tip text={sidebarToggleLabel} side="bottom">');
    expect(chromeActions).toContain('aria-label={sidebarToggleLabel}');
    expect(menuButton).toContain("import { Tip } from '@/components/ui/tooltip';");
    expect(menuButton).toContain("text={t('titleBar.menu')}");
  });

  it('gives both sidebar footer icon actions visible, state-aware tips', () => {
    const source = rendererSource('components/sidebar/UserInfoSection.tsx');

    expect(source).toContain("import { Tip } from '@/components/ui/tooltip';");
    expect(source).toContain('<Tip text={settingsLinkLabel} side="right">');
    expect(source).toContain("text={t('sidebar.user.downloadMobile')}");
    expect(source).toMatch(
      /text=\{\s*isFlameReopen\s*\? t\('sidebar\.user\.reopenUpdateBanner'\)\s*: t\('sidebar\.user\.viewReleaseNotes'\)\s*\}/,
    );
  });

  it('does not exempt session-row icon actions from visible tips', () => {
    const sessionItem = rendererSource('features/cc-agent/sidebar/SessionItem.tsx');
    const sessionCard = rendererSource('features/cc-agent/sidebar/SessionCard.tsx');
    const actionStart = sessionItem.indexOf('function SessionAction(');
    const cardActionStart = sessionCard.indexOf('function CardAction(');

    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(cardActionStart).toBeGreaterThanOrEqual(0);
    expect(sessionItem.slice(actionStart)).toContain('<Tip text={label}');
    expect(sessionCard.slice(cardActionStart)).toContain('<Tip text={label}');
    expect(sessionItem).not.toContain('故意不挂 Tip 浮层');
  });

  it('covers the high-frequency custom sidebar and panel triggers', () => {
    const automation = rendererSource('features/cc-agent/sidebar/AutomationSessionGroupItem.tsx');
    const pinned = rendererSource('features/cc-agent/sidebar/sections/PinnedSection.tsx');
    const search = rendererSource('features/cc-agent/sidebar/ConversationSearchBox.tsx');
    const rail = rendererSource('features/cc-agent/sidebar/RailNav.tsx');
    const sessionHeader = rendererSource('features/cc-agent/SessionContentHeader.tsx');
    const tabBar = rendererSource('features/right-sidebar/TabBar.tsx');

    expect(automation).toContain("text={t('ccAgent.sidebar.automationGroup.menu.more')}");
    expect(pinned).toContain("text={t('ccAgent.sidebar.viewStyle')}");
    expect(search).toContain("text={t('ccAgent.search.open')}");
    expect(rail).toContain('text={t(`ccAgent.sidebar.railNav.${key}`)}');
    expect(sessionHeader).toContain("text={t('ccAgent.sessionHeader.moreActions')}");
    expect(tabBar).toContain("text={t('rightSidebar.tabs.addAria')}");
    expect(tabBar).toContain('<Tip text={closeAriaLabel}>');
  });

  it('keeps disabled icon actions hoverable and explains why they are unavailable', () => {
    const sidebar = rendererSource('features/cc-agent/CCAgentSidebarUpper.tsx');

    expect(sidebar).toContain("t('ccAgent.sidebar.bulkSelection.actionInProgress')");
    expect(sidebar).toContain("t('ccAgent.sidebar.bulkSelection.archiveNone')");
    expect(sidebar).toContain('<Tip text={bulkArchiveLabel} side="bottom">');
    expect(sidebar).toContain('<span className="inline-flex">');
    expect(sidebar).toContain("t('ccAgent.sidebar.creationInProgress')");
  });
});
