import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectsSectionSource = readFileSync(
  resolve(__dirname, '../sections/ProjectsSection.tsx'),
  'utf8',
);
const projectNodeSource = readFileSync(resolve(__dirname, '../sections/ProjectNode.tsx'), 'utf8');

describe('manual project sort drag surface', () => {
  it('starts drag from the project header and does not filter that header out', () => {
    // handle 和 filter 都写进 SortableJS closest()。标题行若同时出现在两边,
    // 项目行就没有任何可拖热区——手动排序看起来像坏了。
    expect(projectsSectionSource).toContain(
      "const MANUAL_PROJECT_SORT_HANDLE = '[data-project-header]'",
    );
    expect(projectsSectionSource).toContain(
      "const MANUAL_PROJECT_SORT_FILTER = 'button, input, textarea, select, a, [data-no-drag]'",
    );
    expect(projectsSectionSource).toContain('handle={MANUAL_PROJECT_SORT_HANDLE}');
    expect(projectsSectionSource).toContain('filter={MANUAL_PROJECT_SORT_FILTER}');
    expect(projectsSectionSource).not.toMatch(
      /MANUAL_PROJECT_SORT_FILTER[\s\S]{0,80}\[data-project-header\]/,
    );
    expect(projectNodeSource).toContain('data-project-header="true"');
    expect(projectNodeSource).toContain('data-no-drag');
  });
});
