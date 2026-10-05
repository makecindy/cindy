import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'app/devices/[deviceId].tsx'),
  'utf8',
);

// 项目作用域页:iOS 不透明顶栏在 iOS 26+ 会被 react-native-screens 再垫一层顶部安全区,
// 标题栏下出现大块空白。页面必须走透明顶栏 + 由列表让出顶栏高度的整页滚动布局。
function projectScopeBranch(): string {
  const start = source.indexOf('if (projectWorkingDir) {');
  const end = source.indexOf('</ListDisclosureScope>', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('device detail project scope header layout', () => {
  it('uses the transparent scroll-edge header', () => {
    const branch = projectScopeBranch();
    const header = branch.slice(branch.indexOf('<SimpleStackHeader'), branch.indexOf('/>', branch.indexOf('titleTestID="deviceDetail.title"')));

    expect(branch).toContain('simpleScrollScreenSafeAreaEdges()');
    expect(header).toMatch(/^\s+scrollEdge\r?$/m);
  });

  it('renders the search entry inside the inset-adjusted list header', () => {
    const branch = projectScopeBranch();
    const listStart = branch.indexOf('<SectionList');
    const listHeader = branch.indexOf('ListHeaderComponent=', listStart);
    const searchActions = branch.indexOf('testID="deviceDetail.projectSearchActions"');
    const searchRow = branch.indexOf("row: 'deviceDetail.projectSearchRow'");

    expect(listStart).toBeGreaterThan(0);
    expect(branch.slice(listStart, listHeader)).toContain('{...simpleScrollInsetProps}');
    expect(listHeader).toBeGreaterThan(listStart);
    expect(searchActions).toBeGreaterThan(listHeader);
    expect(searchRow).toBeGreaterThan(listHeader);
  });
});
