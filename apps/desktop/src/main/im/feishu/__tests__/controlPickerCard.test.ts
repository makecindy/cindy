import { describe, expect, it } from 'vitest';

import type { ControlProject } from '../../shared/controlProjects';
import { createCardBuilders } from '../../shared/cardBuilders';
import { ui } from '../uiText';

// cardBuilders 工厂只依赖 ui 文案包 + effort 查询函数 — 用 feishu 真实文案包
// 构造, effort 固定 'high'(本测试不涉及 model picker)。
const cards = createCardBuilders(ui, () => 'high');

const PROJECTS: ControlProject[] = [
  { workingDir: '/Users/me/proj-a', displayName: 'proj-a', latestActivityMs: 2 },
  { workingDir: '/Users/me/proj-b', displayName: 'proj-b', latestActivityMs: 1 },
];

describe('buildControlPickerCard — 接管态换乘提示', () => {
  it('未接管时 body 不带"当前接管中"提示', () => {
    const spec = cards.buildControlPickerCard({ botAppId: 'bot1', projects: PROJECTS });
    expect(spec.body).not.toContain('当前接管中');
    // 项目按钮 + 退出按钮
    expect(spec.buttons).toHaveLength(PROJECTS.length + 1);
  });

  it('接管态下 body 顶部带当前会话名提示, 按钮结构不变', () => {
    const spec = cards.buildControlPickerCard({
      botAppId: 'bot1',
      projects: PROJECTS,
      currentAttachedTitle: '修复登录 bug',
    });
    expect(spec.body).toContain('当前接管中');
    expect(spec.body).toContain('修复登录 bug');
    // 提示在 body 最前面 (picker hint 之前)
    expect(spec.body!.indexOf('当前接管中')).toBeLessThan(
      spec.body!.indexOf('点工作区往下走'),
    );
    expect(spec.buttons).toHaveLength(PROJECTS.length + 1);
  });

  it('接管态 + 无可选工作区: 空态文案前同样带提示', () => {
    const spec = cards.buildControlPickerCard({
      botAppId: 'bot1',
      projects: [],
      currentAttachedTitle: '修复登录 bug',
    });
    expect(spec.body).toContain('当前接管中');
    expect(spec.body).toContain('还没有可接管的工作区');
    expect(spec.buttons).toHaveLength(1); // 只剩退出按钮
  });

  it('currentAttachedTitle 为 null/缺省时行为一致', () => {
    const a = cards.buildControlPickerCard({ botAppId: 'bot1', projects: PROJECTS });
    const b = cards.buildControlPickerCard({
      botAppId: 'bot1',
      projects: PROJECTS,
      currentAttachedTitle: null,
    });
    expect(b.body).toBe(a.body);
  });
});

describe('buildPermissionModePickerCard — 重试键隔离', () => {
  it('不同权限模式使用不同 sentinel requestId, 不会重放另一项终态', () => {
    const spec = cards.buildPermissionModePickerCard({
      sessionId: 'sess-1',
      agentKind: 'claude-code',
      currentMode: 'auto',
      modes: [
        { id: 'auto', displayName: 'Auto' },
        { id: 'bypassPermissions', displayName: 'Full access' },
      ],
    });

    const requestIds = spec.buttons.map((button) => button.payload?.requestId);
    expect(requestIds).toEqual([
      'permmode-pick:sess-1:auto',
      'permmode-pick:sess-1:bypassPermissions',
    ]);
  });
});
