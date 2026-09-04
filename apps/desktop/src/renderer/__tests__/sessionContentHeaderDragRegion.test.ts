import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ccAgentDir = resolve(__dirname, '..', 'features', 'cc-agent');
const sessionHeaderSource = readFileSync(resolve(ccAgentDir, 'SessionContentHeader.tsx'), 'utf8');
const gitContextBadgeSource = readFileSync(resolve(ccAgentDir, 'GitContextBadge.tsx'), 'utf8');

describe('SessionContentHeader window drag region', () => {
  it('does not mark the whole injected session header as no-drag', () => {
    expect(sessionHeaderSource).toContain(
      '<div className="flex min-w-0 items-center gap-0.5 pl-1">',
    );
    expect(sessionHeaderSource).not.toMatch(
      /<div\s+className="flex min-w-0 items-center gap-0\.5 pl-1"[\s\S]{0,160}WebkitAppRegion: 'no-drag'/,
    );
  });

  it('keeps real controls out of the Electron drag region', () => {
    expect(sessionHeaderSource).toMatch(
      /aria-label=\{t\('ccAgent\.sessionHeader\.moreActions'\)\}[\s\S]{0,120}style=\{WINDOW_NO_DRAG_STYLE\}/,
    );
    // PR chip 的 onClick 按 gh 可用性二选一(打开 PR / 引导 Agent),但按钮本身
    // 必须始终在 no-drag 区,否则两种点击都会被窗口拖拽区吞掉。
    expect(gitContextBadgeSource).toMatch(
      /onClick=\{handleClick\}[\s\S]{0,180}style=\{WINDOW_NO_DRAG_STYLE\}/,
    );
  });

  it('keeps the double-click-to-rename title span out of the drag region', () => {
    // 标题 span 留在 drag region 会让 onDoubleClick 被窗口拖拽区吞掉,
    // 双击改名整体失效(d7dc967df 回归)。
    expect(sessionHeaderSource).toMatch(
      /onDoubleClick=\{startEdit\}[\s\S]{0,240}style=\{WINDOW_NO_DRAG_STYLE\}/,
    );
  });

  it('restores drag-to-move on the title span via manual window drag', () => {
    // no-drag 之后拖窗习惯必须用 useManualWindowDrag 补回:按住标题移动
    // 依旧拖动窗口,双击仍进改名(两者缺一都是回归)。
    expect(sessionHeaderSource).toMatch(
      /\{\.\.\.titleManualDrag\}[\s\S]{0,80}onDoubleClick=\{startEdit\}/,
    );
    expect(sessionHeaderSource).toContain(
      'const titleManualDrag = useManualWindowDrag();',
    );
  });
});
