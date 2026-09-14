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
const sessionItemSource = readFileSync(
  resolve(ccAgentDir, 'sidebar', 'SessionItem.tsx'),
  'utf8',
);
const sessionCardSource = readFileSync(
  resolve(ccAgentDir, 'sidebar', 'SessionCard.tsx'),
  'utf8',
);

// 非菜单条目的 sessionMenu.* 用法,各处都排除后再比较:
//   - moreActions:SessionItem 行内 ··· 按钮的 aria-label(header 用自己的
//     ccAgent.sessionHeader.moreActions)
//   - *Done / *Failed / *Blocked / *Unsupported / *Nothing:动作的 toast 反馈文案
//     (header 的 move/export handler 内联在组件里,非菜单项)
const NON_MENU_KEY_PATTERN = /(?:Done|Failed|Blocked|Unsupported|Nothing)$/;
const NON_MENU_KEYS = new Set(['moreActions']);

// Pi 专属入口暂不进 overflow 菜单(导出 HTML / 压缩上下文)。压缩仍走对话区
// context ring。任务分支只在存在 Cindy 分叉家族时显示,仍是头部专属项。
// 用精确 label 调用守卫,避免 compactSuccess 这类 toast key 被前缀误伤。
const HIDDEN_PI_MENU_LABELS = [
  "t('ccAgent.sidebar.sessionMenu.exportHtml')",
  "t('ccAgent.sidebar.sessionMenu.compact')",
  "t('ccAgent.sidebar.sessionMenu.compacting')",
] as const;
const HEADER_ONLY_KEYS = new Set(['sessionBranches']);

function collectSessionMenuKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(/ccAgent\.sidebar\.sessionMenu\.(\w+)/g)) {
    const key = match[1];
    if (NON_MENU_KEYS.has(key) || HEADER_ONLY_KEYS.has(key) || NON_MENU_KEY_PATTERN.test(key)) continue;
    keys.add(key);
  }
  return keys;
}

describe('session menu parity across header and sidebar variants', () => {
  it('uses the same sessionMenu action keys across all menu variants', () => {
    const headerKeys = collectSessionMenuKeys(headerSource);
    const sidebarKeys = collectSessionMenuKeys(sessionItemSource);
    const cardKeys = collectSessionMenuKeys(sessionCardSource);
    expect([...headerKeys].sort()).toEqual([...sidebarKeys].sort());
    expect([...headerKeys].sort()).toEqual([...cardKeys].sort());
  });

  it('keeps Pi-only extras out of header and sidebar overflow menus', () => {
    for (const source of [headerSource, sessionItemSource, sessionCardSource]) {
      for (const label of HIDDEN_PI_MENU_LABELS) {
        expect(source).not.toContain(label);
      }
    }
  });

  it('keeps the Cindy fork-family branch entry in the header only', () => {
    expect(headerSource).toContain("t('ccAgent.sidebar.sessionMenu.sessionBranches')");
    expect(headerSource).toContain("useCCSessions({ includeArchived: 'all' })");
    expect(headerSource).toContain('Boolean(session.parentSessionId)');
    expect(headerSource).toContain('canShowBranchTree = !isEmpty && hasSessionFamily');
    expect(headerSource).not.toContain("agentKind === 'pi' || hasSessionFamily");
    expect(sessionItemSource).not.toContain("t('ccAgent.sidebar.sessionMenu.sessionBranches')");
    expect(sessionCardSource).not.toContain("t('ccAgent.sidebar.sessionMenu.sessionBranches')");
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
