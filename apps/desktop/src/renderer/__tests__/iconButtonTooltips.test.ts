import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = resolve(__dirname, '..');
const GUARDED_TOOLTIP_ROOTS = [
  'components/layout',
  'components/sidebar',
  'components/title-bar',
  'features/cc-agent/sidebar',
  'features/right-sidebar',
] as const;

function rendererSource(path: string): string {
  return readFileSync(resolve(RENDERER_ROOT, path), 'utf8');
}

function rendererComponentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return rendererComponentFiles(path);
      return /\.[jt]sx$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

function nativeButtonTitleViolations(): string[] {
  const violations: string[] = [];

  for (const root of GUARDED_TOOLTIP_ROOTS) {
    for (const file of rendererComponentFiles(resolve(RENDERER_ROOT, root))) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
      );

      function visit(node: ts.Node): void {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(sourceFile) === 'button'
        ) {
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
          const nativeTitle = attributes.find(
            (attribute) => attribute.name.getText(sourceFile) === 'title',
          );
          const nativeTitleMarker = attributes.find(
            (attribute) => attribute.name.getText(sourceFile) === 'data-native-title',
          );
          const isTruncatedTextException =
            nativeTitleMarker?.initializer &&
            ts.isStringLiteral(nativeTitleMarker.initializer) &&
            nativeTitleMarker.initializer.text === 'truncated-text';

          if (nativeTitle && !isTruncatedTextException) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push(`${relative(RENDERER_ROOT, file)}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }
  }

  return violations;
}

describe('icon-only button tooltip coverage', () => {
  it('centralizes visible tips in shared chrome and sidebar button primitives', () => {
    const chromeButton = rendererSource('components/title-bar/ChromeIconButton.tsx');
    const sidebarButton = rendererSource('components/sidebar/SidebarIconButton.tsx');

    expect(chromeButton).toContain("import { Tip, type TipProps } from '@/components/ui/tooltip';");
    expect(chromeButton).toContain('<Tip text={tooltipText}');
    expect(chromeButton).toContain('role="button"');
    expect(chromeButton).toContain('aria-disabled="true"');
    expect(chromeButton).toContain('tabIndex={0}');
    expect(chromeButton).toContain('aria-hidden={rest.disabled ? true : undefined}');
    expect(chromeButton).not.toContain('<button type="button" title=');
    expect(sidebarButton).toContain("import { Tip } from '@/components/ui/tooltip';");
    expect(sidebarButton).toContain('<Tip text={title ?? label} side="right">');
    expect(sidebarButton).toContain('role="button"');
    expect(sidebarButton).toContain('aria-disabled="true"');
    expect(sidebarButton).toContain('tabIndex={0}');
    expect(sidebarButton).toContain('aria-hidden={disabled ? true : undefined}');
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

  it('keeps disabled icon actions hoverable and keyboard discoverable', () => {
    const sidebar = rendererSource('features/cc-agent/CCAgentSidebarUpper.tsx');

    expect(sidebar).toContain("t('ccAgent.sidebar.bulkSelection.actionInProgress')");
    expect(sidebar).toContain("t('ccAgent.sidebar.bulkSelection.archiveNone')");
    expect(sidebar).toContain('<Tip text={bulkArchiveLabel} side="bottom">');
    expect(sidebar).toContain("role={bulkArchiveDisabled ? 'button' : undefined}");
    expect(sidebar).toContain('tabIndex={bulkArchiveDisabled ? 0 : undefined}');
    expect(sidebar).toContain('aria-hidden={bulkArchiveDisabled ? true : undefined}');
    expect(sidebar).toContain("role={disabled ? 'button' : undefined}");
    expect(sidebar).toContain('tabIndex={disabled ? 0 : undefined}');
    expect(sidebar).toContain("t('ccAgent.sidebar.creationInProgress')");
  });

  it('discovers native button titles anywhere in the guarded migration roots', () => {
    expect(nativeButtonTitleViolations()).toEqual([]);
  });
});
