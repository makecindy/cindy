/**
 * 远程 Agent · 模型档位记忆的渲染端接线(2026-10-07 用户反馈:远程供应商的 effort 等设置
 * 重启或切走再切回就要重新选)。
 *
 * 起因:模型目录在另一台电脑时 ChatInput / 模型面板一概不读写记忆,草稿只靠进程内的「上一次
 * 选择」。这里锁住几条接线:
 *   1. Agent 在另一台电脑时,ChatInput 用本机为那台电脑记的那一份(远程控制仍不掺本机记忆);
 *   2. 面板浏览别的电脑的目录时,各行读写那台电脑的记忆;从本机选到另一台电脑时按目标电脑写;
 *   3. 草稿切模型按那台电脑的每模型档位还原;记忆按账号分区;
 *   4. 已建任务换模 / 换电脑(含下一条消息前再调档)时,档位记进模型所在目录的那份。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

const chatInputSource = read('../components/new-chat/ChatInput.tsx');
const selectorSource = read('../components/new-chat/ModelSelector.tsx');
const panelSource = read('../components/new-chat/UnifiedModelPanel.tsx');
const draftRouteSource = read('../features/cc-agent/NewMakerDraftRoute.tsx');
const authSource = read('../contexts/AuthContext.tsx');

describe('ChatInput:远程 Agent 的模型记忆', () => {
  it('远程控制不掺本机记忆;Agent 在另一台电脑时用那台电脑的记忆', () => {
    const memo = chatInputSource.indexOf('const modelMemory = useMemo<ModelMemoryAccessors | undefined>');
    expect(memo).toBeGreaterThan(0);
    const deviceLink = chatInputSource.indexOf('if (deviceLinkDeviceId) return undefined;', memo);
    const agentDevice = chatInputSource.indexOf(
      'if (catalogDeviceId) return agentDeviceModelMemoryAccessors(catalogDeviceId);',
      memo,
    );
    expect(deviceLink).toBeGreaterThan(memo);
    expect(agentDevice).toBeGreaterThan(deviceLink);
  });

  it('草稿与已建任务的面板都拿到按电脑取记忆的入口', () => {
    expect(chatInputSource.split('deviceModelMemory: agentDeviceModelMemoryAccessors,').length - 1).toBe(2);
  });

  it('从本机选到另一台电脑的模型时,档位按目标电脑写', () => {
    expect(chatInputSource).toContain(
      '? agentDeviceModelMemoryAccessors(selection.agentDevice.deviceId)',
    );
  });

  it('记忆变化时重渲染', () => {
    expect(chatInputSource).toContain('useAgentDeviceModelMemoryVersion();');
  });

  it('按模型所在目录写档位:另一台电脑写那台的一份,本机写本机预设', () => {
    const helper = chatInputSource.indexOf('function rememberCatalogModelPrefs(');
    expect(helper).toBeGreaterThan(0);
    const body = chatInputSource.slice(helper, chatInputSource.indexOf('\n}\n', helper));
    expect(body).toContain(
      'const memory = deviceId ? agentDeviceModelMemoryAccessors(deviceId) : LOCAL_MODEL_MEMORY;',
    );
    expect(body).toContain('memory.setEffort(agent, providerId, modelId, patch.effort)');
    expect(body).toContain('memory.setFast(agent, providerId, modelId, patch.fast)');
  });

  it('Agent 在另一台电脑的任务:换模后意图期调档记进那台的记忆,不写本机新建任务记忆', () => {
    const start = chatInputSource.indexOf('const syncSessionDraftModelPrefs = useCallback(');
    expect(start).toBeGreaterThan(0);
    const agentDeviceBranch = chatInputSource.indexOf('if (agentDeviceId) {', start);
    const remember = chatInputSource.indexOf(
      'rememberCatalogModelPrefs(agentDeviceId, agentKind, memoryProviderId, modelId, patch);',
      agentDeviceBranch,
    );
    const localWrites = chatInputSource.indexOf('setProviderModelChoice(agentKind,', start);
    expect(agentDeviceBranch).toBeGreaterThan(start);
    expect(remember).toBeGreaterThan(agentDeviceBranch);
    // 分支在本机写入之前 return,不掺本机预设与新建任务记忆。
    const earlyReturn = chatInputSource.indexOf('return;', remember);
    expect(earlyReturn).toBeGreaterThan(remember);
    expect(localWrites).toBeGreaterThan(earlyReturn);
  });

  it('已有任务换电脑:档位记进目标电脑那份目录的记忆', () => {
    expect(chatInputSource).toContain(
      'rememberCatalogModelPrefs(relocateTo, targetAgentKind, providerId, newModelId, {',
    );
    expect(chatInputSource).toMatch(
      /rememberCatalogModelPrefs\(\s*relocateTo,\s*targetAgentKind,\s*syncedProviderId,\s*newModelId,\s*syncedPatch,\s*\)/,
    );
  });
});

describe('模型面板:浏览别的电脑的目录', () => {
  it('不是 Agent 当前所在电脑的目录时,读写那台电脑的记忆', () => {
    expect(selectorSource).toContain('remoteAgent.deviceModelMemory?.(remoteBrowse.deviceId)');
  });

  it('选择器与联合面板都订阅这份记忆的版本号', () => {
    expect(selectorSource).toContain('useAgentDeviceModelMemoryVersion()');
    expect(panelSource).toContain(
      'const memoryVersion = useProviderModelMemoryVersion() + useAgentDeviceModelMemoryVersion();',
    );
  });
});

describe('草稿与账号分区', () => {
  it('草稿取回那台电脑的选择时随记忆变化重新计算', () => {
    const memo = draftRouteSource.indexOf('const deviceDraftDefaults = useMemo<RemoteDraftDefaults | null>(');
    expect(memo).toBeGreaterThan(0);
    const deps = draftRouteSource.indexOf('agentDeviceModelMemoryVersion,', memo);
    expect(deps).toBeGreaterThan(memo);
  });

  it('随登录账号切换分区', () => {
    expect(authSource).toContain('setAgentDeviceModelMemoryOwner(state.dataOwnerId);');
  });
});
