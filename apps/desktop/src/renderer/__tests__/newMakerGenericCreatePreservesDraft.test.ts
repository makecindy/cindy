/**
 * newMakerGenericCreatePreservesDraft.test.ts
 * ---------------------------------------------------------------------------
 * 回归(2026-07):通用「新建」入口不得清空 newMakerDraft。
 *
 * 背景:草稿页(/cc-agent/new)的「对话或选择项目」选择由 newMakerDraft store
 * 持久化。此前展开态 SidebarTopNav.handleNew 与折叠态 CCAgentSidebarUpper.handleNewCCS
 * 都会先重置 newMakerDraft
 * 再 navigate,导致用户选好项目后切到别的会话、再点「新建」回来时选择被重置为默认、
 * 需要重新选。修复后这两个通用入口只 navigate、不清空;清空语义只保留在「新建对话」
 * 等显式入口(handleCreateDialogue)。
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

/** 抽出某个 handler 的实现体(从 `const <name> =` 到该 handler 结束的 `}, [` / `};`)。 */
function extractHandlerBlock(source: string, name: string): string {
  const re = new RegExp(`const ${name}\\s*=\\s*[\\s\\S]*?(?:\\}, \\[|\\};)`);
  const match = source.match(re);
  expect(match, `expected to find handler ${name}`).not.toBeNull();
  return match![0];
}

describe('通用「新建」保留 newMakerDraft 选择', () => {
  it('展开态 SidebarTopNav.handleNew 只 navigate、不清空 workingDir', () => {
    const block = extractHandlerBlock(topNavSource, 'handleNew');
    expect(block).toMatch(/navigate\(['`]\/cc-agent\/new['`]/);
    expect(block).not.toContain('workingDir: null');
    // 通用入口不再需要 patchDraft/patchNewMakerDraft,连 value import 都应移除。
    expect(topNavSource).not.toContain("from '@/state/newMakerDraft'");
  });

  it('折叠态 CCAgentSidebarUpper.handleNewCCS 只 navigate、不清空 workingDir', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleNewCCS');
    expect(block).toMatch(
      /navigate\(['`]\/cc-agent\/new['`],\s*\{\s*state:\s*makeNewMakerRouteState\('generic'\)\s*\}\)/,
    );
    expect(block).not.toContain('workingDir: null');
  });

  it('显式「新建对话」入口仍清空 workingDir,但由创建页集中迁移目标', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleCreateDialogue');
    // 2026-08-12 起 handler 接受可选的显式设备目标(按设备分组时对话组给出所属设备);
    // 未给时仍按当前机器作用域推断,route state 由统一的 target 变量组装。
    expect(block).toContain('state: makeDialogueNewMakerRouteState(target)');
    expect(block).toContain('target = selectedDialogueDeviceResolution.target;');
    expect(block).toContain("selectedDialogueDeviceResolution.status === 'pending'");
    expect(block).not.toContain('resetDraftWorkspaceTargets');
    expect(draftRouteSource).toMatch(
      /applyDraftTarget\(\{\s*deviceId: dialogueTargetRequest\.deviceId,\s*deviceName: dialogueTargetRequest\.deviceName,\s*workingDir: null,/,
    );
  });

  // 保留与清空的分界(2026-07-25 用户定稿):workingDir / 文本 / 模型是便利性
  // 记忆,通用「新建」保留;extraDirs 是单次授权范围,每次进入草稿页必须从空开始
  //(否则旧目录会无感知地带进新会话)。清空由 NewMakerDraftRoute mount 效果承担,
  // 通用入口依旧不 patch store(前两条断言不受影响)。
  it('NewMakerDraftRoute mount 时清空 extraDirs(引用目录不跨草稿保留)', () => {
    expect(draftRouteSource).toContain(
      "if (getDraft().extraDirs.length > 0 || getDraft().writableDirs.length > 0) {",
    );
  });
});
