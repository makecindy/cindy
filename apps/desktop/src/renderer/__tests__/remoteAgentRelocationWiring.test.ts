/**
 * 远程 Agent · 已建任务换电脑的渲染端接线(2026-10-07 用户裁决:选模型即可换 Agent 位置)。
 *
 * 起因:Agent 在另一台电脑运行的任务里选了本机模型,选择被转给那台电脑报 Model not found,
 * 之后每次发送都卡住。这里锁住渲染端的几条不变量:
 *   1. 面板浏览的不是 Agent 落点那台的目录时,同引擎 / 跨引擎两条会话链路都改道给 onRelocate;
 *   2. 换位置带着目标电脑进切换事务,意图期内的后续改选沿用意图里的电脑;
 *   3. 意图期内模型目录跟随意图里的电脑,选回任务当前所在电脑不带位置;
 *   4. 只有本机任务、且能走切换事务时才开放(SSH / 被控端 / 协同任务不开放)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

const selectorSource = read('../components/new-chat/ModelSelector.tsx');
const chatInputSource = read('../components/new-chat/ChatInput.tsx');

describe('ModelSelector:浏览别的电脑的目录时改道换位置', () => {
  it('只在已建任务、且浏览的不是落点目录时改道', () => {
    expect(selectorSource).toContain(
      'remoteAgent?.onRelocate && !onUnifiedSelect && !browsingSelectedCatalog',
    );
  });

  it('行选中在同引擎会话链路之前先走 relocate', () => {
    const relocateBranch = selectorSource.indexOf('if (relocate) {');
    const sessionApply = selectorSource.indexOf('return applyUnifiedSessionSelect({', relocateBranch);
    expect(relocateBranch).toBeGreaterThan(0);
    expect(sessionApply).toBeGreaterThan(relocateBranch);
  });

  it('跨引擎行也改道:替换 onCrossEngineSelect / onCrossEngineConfigure,并把整份过滤器交给面板', () => {
    const filter = selectorSource.indexOf('const panelSessionEngineFilter =');
    expect(filter).toBeGreaterThan(0);
    expect(selectorSource.indexOf('onCrossEngineSelect: (args', filter)).toBeGreaterThan(filter);
    expect(selectorSource.indexOf('onCrossEngineConfigure: (args', filter)).toBeGreaterThan(filter);
    expect(selectorSource).toContain(
      '{...(panelSessionEngineFilter ? { sessionEngineFilter: panelSessionEngineFilter } : {})}',
    );
  });

  it('改道的行带上所属电脑', () => {
    expect(selectorSource).toContain('relocate!({ ...row, agentDevice: remoteBrowseDevice })');
  });
});

describe('ChatInput:换位置进切换事务', () => {
  it('位置来自显式选择,否则沿用意图里的电脑;与任务当前所在电脑相同就不带', () => {
    expect(chatInputSource).toContain(
      'overrides?.agentDeviceId !== undefined ? overrides.agentDeviceId : pendingAgentDeviceId;',
    );
    expect(chatInputSource).toContain('requestedAgentDeviceId !== agentDeviceId');
    expect(chatInputSource).toContain('{ agentDeviceId: relocateTo },');
  });

  it('回声匹配把位置算进意图;登记时写入位置;换电脑不写本机新建任务记忆', () => {
    expect(chatInputSource).toContain('registeredIntent.agentDeviceId === relocateTo;');
    expect(chatInputSource).toContain(
      '...(relocateTo !== undefined ? { agentDeviceId: relocateTo } : {}),',
    );
    // 换电脑只把档位记进目标目录的记忆,不走写新建任务记忆的 syncSessionDraftModelPrefs。
    expect(chatInputSource.split('if (relocateTo !== undefined) {').length - 1).toBe(2);
    expect(chatInputSource).not.toContain('if (relocateTo === undefined) syncSessionDraftModelPrefs(');
  });

  it('意图期内目录跟随意图里的电脑', () => {
    expect(chatInputSource).toContain(
      'const catalogDeviceId = deviceLinkDeviceId ?? effectiveAgentDeviceId ?? undefined;',
    );
  });

  it('只对本机任务、且能走切换事务时开放', () => {
    expect(chatInputSource).toContain(
      'if (!sessionId || deviceLinkDeviceId || remoteHostId || !sessionEngineFilter) return undefined;',
    );
    expect(chatInputSource).toContain('agentDeviceId: selection.agentDevice?.deviceId ?? null,');
  });
});
