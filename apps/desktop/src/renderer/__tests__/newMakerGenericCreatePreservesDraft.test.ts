/**
 * newMakerGenericCreatePreservesDraft.test.ts
 * ---------------------------------------------------------------------------
 * 全局「新任务」的 workspace 契约(2026-07-29 上下文快捷入口重构):
 *
 *   - fresh task(无未发送草稿):进入 /cc-agent/new 前重置为 Dialogue
 *     (workingDir/remoteHostId/deviceLink/extraDirs 清空),不再继承上一次
 *     空草稿页选中的项目——从全局入口开始新工作不应无感知地落进旧项目。
 *   - existing draft(有真实未发送草稿):完全不动 workspace,恢复原草稿
 *     及其项目上下文——这是 2026-07 那轮「通用新建不清空草稿」修复要保住的
 *     数据安全底线,现在由 prepareGlobalNewTask 的 presence 门槛承担
 *     (分支行为的单元测试见 newTaskNavigation.test.ts)。
 *   - 只重置 workspace 维度:模型/供应商/推理强度/权限等 vendor 偏好不动。
 *
 * 静态扫描风格(renderer 测试环境无 jsdom),与 sidebarUpperSingleButton.test.ts 一致。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const topNavSource = readFileSync(
  resolve(__dirname, '..', 'components', 'sidebar', 'SidebarTopNav.tsx'),
  'utf8',
);

const sidebarUpperSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

const draftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const prepareSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'prepareGlobalNewTask.ts'),
  'utf8',
);

/** 抽出某个 handler 的实现体(从 `const <name> =` 到该 handler 结束的 `}, [` / `};`)。 */
function extractHandlerBlock(source: string, name: string): string {
  const re = new RegExp(`const ${name}\\s*=\\s*[\\s\\S]*?(?:\\}, \\[|\\};)`);
  const match = source.match(re);
  expect(match, `expected to find handler ${name}`).not.toBeNull();
  return match![0];
}

describe('全局「新任务」workspace 契约', () => {
  it('展开态 SidebarTopNav.handleNew 经 prepareGlobalNewTask 决定 fresh/resume 再 navigate', () => {
    const block = extractHandlerBlock(topNavSource, 'handleNew');
    expect(block).toContain('prepareGlobalNewTask();');
    expect(block).toMatch(/navigate\(['`]\/cc-agent\/new['`]/);
    // workspace 重置逻辑收敛在 prepareGlobalNewTask 单点,入口不各写一份。
    expect(block).not.toContain('workingDir: null');
    expect(topNavSource).not.toContain("from '@/state/newMakerDraft'");
  });

  it('折叠态 CCAgentSidebarUpper.handleNewCCS 与展开态同口径', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleNewCCS');
    expect(block).toContain('prepareGlobalNewTask();');
    expect(block).toMatch(
      /navigate\(['`]\/cc-agent\/new['`],\s*\{\s*state:\s*makeNewMakerRouteState\('generic'\)\s*\}\)/,
    );
    expect(block).not.toContain('workingDir: null');
  });

  it('prepareGlobalNewTask 有草稿即早退,fresh 只重置 workspace 维度、不碰 vendor 偏好', () => {
    // 草稿保护:presence 命中直接 resume-draft,不 patch。
    expect(prepareSource).toContain("if (getDraftPresence(NEW_MAKER_DRAFT_KEY)) return 'resume-draft';");
    // 重置面收敛为 workspace 五字段;lastByVendor/vendor/effortByModel 等偏好不得出现。
    expect(prepareSource).toContain('workingDir: null');
    expect(prepareSource).toContain('remoteHostId: null');
    expect(prepareSource).toContain('deviceLinkDeviceId: null');
    expect(prepareSource).toContain('extraDirs: []');
    expect(prepareSource).not.toContain('lastByVendor');
    expect(prepareSource).not.toContain('vendor:');
    expect(prepareSource).not.toContain('effortByModel');
    expect(prepareSource).not.toContain('fastModeByModel');
  });

  it('显式「新建对话」入口 handleCreateDialogue 仍直接清空 workingDir(语义不同,不合并)', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleCreateDialogue');
    expect(block).toContain('patchNewMakerDraft({ workingDir: null, remoteHostId: null, extraDirs: [] })');
  });

  // 保留与清空的分界(2026-07-25 用户定稿):extraDirs 是单次授权范围,每次进入
  // 草稿页必须从空开始(否则旧目录会无感知地带进新会话)。清空由 NewMakerDraftRoute
  // mount 效果承担,与入口侧的 fresh 重置互为双保险。
  it('NewMakerDraftRoute mount 时清空 extraDirs(引用目录不跨草稿保留)', () => {
    expect(draftRouteSource).toContain(
      "if (getDraft().extraDirs.length > 0) patchDraft({ extraDirs: [] });",
    );
  });
});
