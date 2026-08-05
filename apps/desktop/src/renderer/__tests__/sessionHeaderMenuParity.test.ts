import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 顶部会话标题菜单(SessionContentHeader)与侧栏会话右键菜单(SessionItem)
 * 的条目一致性回归:两边必须使用同一组 sessionMenu.* 动作(产品要求两处菜单
 * 保持一致)。任何一边单独增删菜单项都会让本测试失败,提醒同步另一边。
 */
const ccAgentDir = resolve(__dirname, '..', 'features', 'cc-agent');
const headerSource = readFileSync(resolve(ccAgentDir, 'SessionContentHeader.tsx'), 'utf8');
const sessionItemSource = readFileSync(
  resolve(ccAgentDir, 'sidebar', 'SessionItem.tsx'),
  'utf8',
);

// 非菜单条目的 sessionMenu.* 用法,两边都排除后再比较:
//   - moreActions:SessionItem 行内 ··· 按钮的 aria-label(header 用自己的
//     ccAgent.sessionHeader.moreActions)
//   - *Done / *Failed / *Blocked / *Unsupported:move 动作的 toast 反馈文案
//     (header 的 move handler 内联在组件里,SessionItem 的在 CCAgentSidebarUpper)
const NON_MENU_KEY_PATTERN = /(?:Done|Failed|Blocked|Unsupported)$/;
const NON_MENU_KEYS = new Set(['moreActions']);

function collectSessionMenuKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(/ccAgent\.sidebar\.sessionMenu\.(\w+)/g)) {
    const key = match[1];
    if (NON_MENU_KEYS.has(key) || NON_MENU_KEY_PATTERN.test(key)) continue;
    keys.add(key);
  }
  return keys;
}

describe('SessionContentHeader menu parity with SessionItem', () => {
  it('uses the same sessionMenu action keys as the sidebar context menu', () => {
    const headerKeys = collectSessionMenuKeys(headerSource);
    const sidebarKeys = collectSessionMenuKeys(sessionItemSource);
    expect([...headerKeys].sort()).toEqual([...sidebarKeys].sort());
  });

  it('reuses the shared submenu / export dialog / menu style modules', () => {
    expect(headerSource).toContain("from './sidebar/menuStyles'");
    expect(sessionItemSource).toContain("from './menuStyles'");
    for (const source of [headerSource, sessionItemSource]) {
      expect(source).toContain('SessionProjectMoveSubmenu');
      expect(source).toContain('SessionShareExportDialog');
    }
  });
});
