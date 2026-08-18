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
const WINDOWS_SYSTEM_CONTROL_PATH = 'components/title-bar/WindowControls.tsx';
const WINDOWS_SYSTEM_CONTROL_TOOLTIP_EXEMPTION = 'windows-system-control';

function normalizeRendererPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function rendererSource(path: string): string {
  return readFileSync(resolve(RENDERER_ROOT, path), 'utf8');
}

function rendererComponentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : rendererComponentFiles(path);
      }
      return /\.[jt]sx$/.test(entry.name) && !/\.(?:test|spec)\.[jt]sx$/.test(entry.name)
        ? [path]
        : [];
    })
    .sort();
}

type JsxOpeningLikeElement = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function jsxAttribute(
  node: JsxOpeningLikeElement,
  name: string,
  sourceFile: ts.SourceFile,
): ts.JsxAttribute | undefined {
  return node.attributes.properties
    .filter(ts.isJsxAttribute)
    .find((attribute) => attribute.name.getText(sourceFile) === name);
}

function staticAttributeValue(attribute: ts.JsxAttribute | undefined): string | true | undefined {
  if (!attribute) return undefined;
  if (!attribute.initializer) return true;
  return ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : undefined;
}

function jsxTagName(node: JsxOpeningLikeElement, sourceFile: ts.SourceFile): string {
  return node.tagName.getText(sourceFile);
}

function jsxElementForOpening(
  node: JsxOpeningLikeElement,
): ts.JsxElement | ts.JsxSelfClosingElement {
  return ts.isJsxOpeningElement(node) ? node.parent : node;
}

function expressionContainsButtonRole(expression: ts.Expression): boolean {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text === 'button';
  }
  return expression
    .getChildren()
    .some((child) => (ts.isExpression(child) ? expressionContainsButtonRole(child) : false));
}

function hasButtonRole(node: JsxOpeningLikeElement, sourceFile: ts.SourceFile): boolean {
  const role = jsxAttribute(node, 'role', sourceFile);
  if (!role?.initializer) return false;
  if (ts.isStringLiteral(role.initializer)) return role.initializer.text === 'button';
  return (
    ts.isJsxExpression(role.initializer) &&
    role.initializer.expression !== undefined &&
    expressionContainsButtonRole(role.initializer.expression)
  );
}

function isInteractiveControl(node: JsxOpeningLikeElement, sourceFile: ts.SourceFile): boolean {
  return jsxTagName(node, sourceFile) === 'button' || hasButtonRole(node, sourceFile);
}

function expressionHasPersistentText(expression: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression)
  ) {
    return expression.text.length > 0;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return expressionHasPersistentText(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionHasPersistentText(expression.whenTrue) ||
      expressionHasPersistentText(expression.whenFalse)
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return (
      expressionHasPersistentText(expression.left) || expressionHasPersistentText(expression.right)
    );
  }
  if (ts.isJsxElement(expression) || ts.isJsxFragment(expression)) {
    return jsxChildrenHavePersistentText(expression.children);
  }
  if (ts.isJsxSelfClosingElement(expression)) return false;

  // A dynamic value rendered as a child is persistent visible content (for example
  // `{label}`). Icon components instead arrive as JSX elements and take the branches above.
  return true;
}

function jsxChildrenHavePersistentText(children: ts.NodeArray<ts.JsxChild>): boolean {
  return children.some((child) => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0;
    if (ts.isJsxExpression(child)) {
      return child.expression ? expressionHasPersistentText(child.expression) : false;
    }
    if (ts.isJsxElement(child) || ts.isJsxFragment(child)) {
      return jsxChildrenHavePersistentText(child.children);
    }
    return false;
  });
}

function isIconOnlyControl(node: JsxOpeningLikeElement): boolean {
  return ts.isJsxSelfClosingElement(node) || !jsxChildrenHavePersistentText(node.parent.children);
}

function isDirectTooltipTrigger(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node;

  while (current?.parent) {
    const parent: ts.Node = current.parent;
    if (ts.isJsxElement(parent)) {
      const tagName = jsxTagName(parent.openingElement, sourceFile);
      if (tagName === 'Tip' || tagName === 'Tooltip.Trigger') return true;
      return false;
    }
    if (ts.isJsxSelfClosingElement(parent)) return false;
    current = parent;
  }
  return false;
}

function variableDeclarationForControl(
  node: JsxOpeningLikeElement,
): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = jsxElementForOpening(node);

  while (current?.parent) {
    const parent: ts.Node = current.parent;
    if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) return undefined;
    if (ts.isVariableDeclaration(parent) && parent.initializer) return parent;
    current = parent;
  }
  return undefined;
}

function hasManagedTip(node: JsxOpeningLikeElement, sourceFile: ts.SourceFile): boolean {
  if (isDirectTooltipTrigger(jsxElementForOpening(node), sourceFile)) return true;

  const declaration = variableDeclarationForControl(node);
  if (!declaration || !ts.isIdentifier(declaration.name)) return false;

  const declarationName = declaration.name;
  const bindingName = declarationName.text;
  const scope = declaration.parent.parent.parent;
  let covered = false;

  function visit(candidate: ts.Node): void {
    if (
      !covered &&
      ts.isIdentifier(candidate) &&
      candidate.text === bindingName &&
      candidate !== declarationName &&
      isDirectTooltipTrigger(candidate, sourceFile)
    ) {
      covered = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }

  visit(scope);
  return covered;
}

function tooltipContractViolations(): string[] {
  const violations: string[] = [];

  for (const root of GUARDED_TOOLTIP_ROOTS) {
    for (const file of rendererComponentFiles(resolve(RENDERER_ROOT, root))) {
      const source = readFileSync(file, 'utf8');
      const rendererRelativePath = normalizeRendererPath(relative(RENDERER_ROOT, file));
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
      );

      function visit(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const nativeTitle = jsxAttribute(node, 'title', sourceFile);
          const nativeTitleMarker = jsxAttribute(node, 'data-native-title', sourceFile);
          const isTruncatedTextException =
            staticAttributeValue(nativeTitleMarker) === 'truncated-text';
          const ariaHidden = jsxAttribute(node, 'aria-hidden', sourceFile);
          const isHiddenFromAccessibilityTree = staticAttributeValue(ariaHidden) === 'true';
          const tooltipExemption = jsxAttribute(node, 'data-tooltip-exempt', sourceFile);
          const isWindowsSystemControlException =
            rendererRelativePath === WINDOWS_SYSTEM_CONTROL_PATH &&
            staticAttributeValue(tooltipExemption) ===
              WINDOWS_SYSTEM_CONTROL_TOOLTIP_EXEMPTION;
          const isIconControl =
            isInteractiveControl(node, sourceFile) &&
            !isHiddenFromAccessibilityTree &&
            isIconOnlyControl(node);

          if (
            (nativeTitle && isInteractiveControl(node, sourceFile) && !isTruncatedTextException) ||
            (isIconControl &&
              !isWindowsSystemControlException &&
              !hasManagedTip(node, sourceFile))
          ) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push(`${rendererRelativePath}:${line + 1}`);
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

  it('keeps Windows system window controls accessible without visible tips', () => {
    const windowControls = rendererSource(WINDOWS_SYSTEM_CONTROL_PATH);

    expect(normalizeRendererPath('components\\title-bar\\WindowControls.tsx')).toBe(
      WINDOWS_SYSTEM_CONTROL_PATH,
    );
    expect(windowControls).not.toContain("import { Tip } from '@/components/ui/tooltip';");
    expect(windowControls).not.toContain('<Tip');
    expect(
      windowControls.match(/data-tooltip-exempt="windows-system-control"/g),
    ).toHaveLength(4);
    expect(windowControls).toContain("aria-label={t('titleBar.minimize')}");
    expect(windowControls).toContain("aria-label={t('titleBar.maximizeOrRestore')}");
    expect(windowControls).toContain("aria-label={t('titleBar.close')}");
    expect(windowControls).toContain("aria-label={t('titleBar.closing.title')}");
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
    expect(sessionItem).toContain("<Tip text={t('ccAgent.sidebar.scheduleBinding.viewTask')}");
    expect(sessionCard).toContain("<Tip text={t('ccAgent.sidebar.scheduleBinding.viewTask')}");
    expect(sessionItem).not.toContain("<Tip text={t('ccAgent.sidebar.automationGenerated')}");
    expect(sessionCard).not.toContain("<Tip text={t('ccAgent.sidebar.automationGenerated')}");
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

  it('keeps modal tips visible and row details separate from inline action tips', () => {
    const mobileDownload = rendererSource('components/sidebar/MobileDownloadDialog.tsx');
    const sessionExport = rendererSource('features/cc-agent/sidebar/SessionShareExportDialog.tsx');
    const automation = rendererSource('features/cc-agent/sidebar/AutomationSessionGroupItem.tsx');
    const sessionItem = rendererSource('features/cc-agent/sidebar/SessionItem.tsx');

    expect(mobileDownload).toMatch(
      /text=\{t\('sidebar\.mobileDownload\.close'\)\}[\s\S]*?contentClassName="z-\[10001\]"/,
    );
    expect(sessionExport).toMatch(
      /sessionShare\.export\.(?:hide|show)Password[\s\S]*?contentClassName="z-\[10001\]"/,
    );
    expect(automation).toContain('controlledOpen={rowTooltipOpen}');
    expect(automation).toContain('setRowTooltipOpen(!isAutomationGroupInlineAction(event.target))');
    expect(automation).toContain('onPointerLeave={() => setRowTooltipOpen(false)}');
    expect(automation).toContain('onFocusCapture={(event) => {');
    expect(automation).toContain('onBlurCapture={(event) => {');
    expect(automation.match(/^\s+data-automation-group-inline-action="true"/gm)).toHaveLength(4);
    expect(sessionItem).toContain('const [rowTooltipOpen, setRowTooltipOpen] = useState(false)');
    expect(sessionItem).toContain(
      'setRowTooltipOpen(!isNestedSessionRowAction(event.target, event.currentTarget))',
    );
    expect(sessionItem).toContain('onPointerLeave={() => setRowTooltipOpen(false)}');
    expect(sessionItem).toContain('controlledOpen={rowTooltipOpen}');
  });

  it('keeps disabled icon actions hoverable and keyboard discoverable', () => {
    const sidebar = rendererSource('features/cc-agent/CCAgentSidebarUpper.tsx');
    const backgroundTasks = rendererSource(
      'features/right-sidebar/plugins/background-tasks/BackgroundTasksBody.tsx',
    );

    expect(sidebar).toContain("t('ccAgent.sidebar.bulkSelection.actionInProgress')");
    expect(sidebar).toContain("t('ccAgent.sidebar.bulkSelection.archiveNone')");
    expect(sidebar).toContain('`${bulkArchiveActionLabel} — ${bulkActionInProgressLabel}`');
    expect(sidebar).toContain('`${bulkDeleteActionLabel} — ${bulkActionInProgressLabel}`');
    expect(sidebar).toContain('`${bulkClearActionLabel} — ${bulkActionInProgressLabel}`');
    expect(sidebar).toContain('<Tip text={bulkArchiveLabel} side="bottom">');
    expect(sidebar).toContain("role={bulkArchiveDisabled ? 'button' : undefined}");
    expect(sidebar).toContain('tabIndex={bulkArchiveDisabled ? 0 : undefined}');
    expect(sidebar).toContain('aria-hidden={bulkArchiveDisabled ? true : undefined}');
    expect(sidebar).toContain("role={disabled ? 'button' : undefined}");
    expect(sidebar).toContain('tabIndex={disabled ? 0 : undefined}');
    expect(sidebar).toContain(
      'disabled && disabledReason ? `${actionLabel} — ${disabledReason}` : actionLabel',
    );
    expect(sidebar).toContain("t('ccAgent.sidebar.newDialogue')");
    expect(sidebar).toContain("t('ccAgent.sidebar.creationInProgress')");
    expect(sidebar).toContain("t('ccAgent.sidebar.projectAction.newInDirectory')");
    expect(sidebar).toContain("t('ccAgent.remoteSession.actionsUnavailable')");
    expect(backgroundTasks).toContain(
      "`${actionLabel} — ${t('rightSidebar.backgroundTasks.stopping')}`",
    );
    const rail = rendererSource('features/cc-agent/sidebar/RailNav.tsx');
    expect(rail).toContain('controlledOpen={panelState.openSection === key ? false : undefined}');
  });

  it('discovers native titles and icon controls without a managed Tip in guarded roots', () => {
    expect(tooltipContractViolations()).toEqual([]);
  });
});
