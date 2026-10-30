import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 顶部会话标题菜单(SessionContentHeader)与侧栏会话右键菜单(SessionItem / SessionCard)
 * 的条目一致性回归:三处必须使用同一组 sessionMenu.* 动作(产品要求各处菜单
 * 保持一致)。任何一边单独增删菜单项都会让本测试失败,提醒同步另一边。
 */
const ccAgentDir = resolve(__dirname, '..', 'features', 'cc-agent');
const headerSource = readFileSync(resolve(ccAgentDir, 'SessionContentHeader.tsx'), 'utf8');
const sessionItemSource = readFileSync(resolve(ccAgentDir, 'sidebar', 'SessionItem.tsx'), 'utf8');
const sessionCardSource = readFileSync(resolve(ccAgentDir, 'sidebar', 'SessionCard.tsx'), 'utf8');

const sharedMenuSource = readFileSync(
  resolve(ccAgentDir, 'sidebar', 'SessionTaskMenu.tsx'),
  'utf8',
);

describe('session menu parity across header and sidebar variants', () => {
  it('routes every surface through the same menu implementation', () => {
    for (const source of [headerSource, sessionItemSource, sessionCardSource]) {
      expect(source).toContain('<SessionTaskMenu');
      expect(source).not.toContain('<DropdownMenuContent');
    }
  });

  it('keeps removed extras out of all task menus', () => {
    for (const source of [headerSource, sessionItemSource, sessionCardSource, sharedMenuSource]) {
      for (const key of ['exportHtml', 'compact', 'compacting', 'sessionBranches']) {
        expect(source).not.toContain(`sessionMenu.${key}')`);
        expect(source).not.toContain(`item('${key}'`);
      }
    }
  });

  it('reuses the shared submenu / export dialog / menu style modules', () => {
    expect(headerSource).toContain("from './sidebar/menuStyles'");
    expect(sessionItemSource).toContain("from './menuStyles'");
    expect(sessionCardSource).toContain("from './menuStyles'");
    for (const source of [headerSource, sessionItemSource, sessionCardSource]) {
      expect(source).toContain('SessionProjectMoveSubmenu');
      expect(source).toContain('SessionShareExportDialog');
    }
  });
});
