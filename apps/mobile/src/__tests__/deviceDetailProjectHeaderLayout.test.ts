import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('screen.tsx', readFileSync(
  resolve(process.cwd(), 'app/devices/[deviceId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let branch = '';
function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(source) === 'projectWorkingDir') {
    branch = node.thenStatement.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!branch) throw new Error('Missing production project-scope render branch');
const compiled = ts.transpileModule('function renderProject() ' + branch, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'createElement' },
}).outputText;

type Element = ReactElement<Record<string, any>>;
function find(element: Element, type: string): Element | undefined {
  if (element?.type === type) return element;
  const children = [element?.props?.children, element?.props?.ListHeaderComponent].flat(Infinity);
  for (const child of children) {
    if (child && typeof child === 'object') {
      const result = find(child, type);
      if (result) return result;
    }
  }
}

// Unit: execute the production JSX branch and inspect delivered native props.
// iOS 26 double safe-area and Android Fabric clipping are separate regressions;
// source strings could pass even when later spreads overrode the effective props.
function renderProject(searchOpen: boolean) {
  const inset = { contentInsetAdjustmentBehavior: 'automatic' };
  const scope: Record<string, unknown> = {
    createElement, projectWorkingDir: '/project', sections: [], displaySections: [],
    showConnectionBanner: false, loading: false, status: 'connected', styles: {}, effectiveError: null,
    simpleScrollScreenSafeAreaEdges: () => ['left', 'right', 'bottom'],
    simpleScrollInsetProps: inset, usesNativeStackHeader: () => true, headerHeight: 88,
    t: (key: string) => key, projectName: 'Project', deviceName: 'Computer', deviceId: 'device',
    goBackGuarded: vi.fn(), guardedPush: vi.fn(), router: {}, loadSessions: vi.fn(),
    colors: { textSecondary: 'secondary' }, spacing: { xxl: 24 }, disclosure: { controller: {} },
    viewport: null, searchOpen, searchQuery: '', indexedSearch: { activeFilterCount: 0 },
    searchFilterA11y: '', searchFilterMenu: {}, setSearchQuery: vi.fn(), setSearchOpen: vi.fn(),
    setSearchFilterOpen: vi.fn(), suppressListEmptyState: true, actionOverlays: null,
  };
  for (const name of ['SafeAreaView', 'SimpleStackHeader', 'View', 'ListDisclosureScope',
    'SectionList', 'DeviceListCell', 'RefreshControl', 'HomeSearchBar', 'MainWindowActionGroup',
    'RemoteListSyncingPlaceholder']) scope[name] = name;
  const tree = new Function(...Object.keys(scope), compiled + '; return renderProject();')(
    ...Object.values(scope),
  ) as Element;
  return { tree, inset };
}

describe('device detail project list native layout', () => {
  it.each([false, true])('delivers scroll-edge/inset/clipping props with searchOpen=%s', (searchOpen) => {
    const { tree, inset } = renderProject(searchOpen);
    expect(tree.props.edges).toEqual(['left', 'right', 'bottom']);
    expect(find(tree, 'SimpleStackHeader')?.props.scrollEdge).toBe(true);
    const list = find(tree, 'SectionList')!;
    expect(list.props).toMatchObject({ ...inset, removeClippedSubviews: false });
    const search = find(list.props.ListHeaderComponent, searchOpen ? 'HomeSearchBar' : 'MainWindowActionGroup');
    expect(search).toBeDefined();
    if (searchOpen) expect(search!.props.testIDs.row).toBe('deviceDetail.projectSearchRow');
    else expect(search!.props.testID).toBe('deviceDetail.projectSearchActions');
  });
});
