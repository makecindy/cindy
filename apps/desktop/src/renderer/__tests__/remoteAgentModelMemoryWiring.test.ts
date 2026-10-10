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
  it('Agent 在另一台电脑时用那台电脑的记忆(被控电脑上的任务也是);远程控制不掺本机记忆', () => {
    const memo = chatInputSource.indexOf('const modelMemory = useMemo<ModelMemoryAccessors | undefined>');
    expect(memo).toBeGreaterThan(0);
    const agentDevice = chatInputSource.indexOf(
      'if (effectiveAgentDeviceId) return agentDeviceModelMemoryAccessors(effectiveAgentDeviceId);',
      memo,
    );
    const mirror = chatInputSource.indexOf('if (modelMemoryOverride) return modelMemoryOverride;', memo);
    const deviceLink = chatInputSource.indexOf('if (deviceLinkDeviceId) return undefined;', memo);
    const local = chatInputSource.indexOf('return LOCAL_MODEL_MEMORY;', memo);
    expect(agentDevice).toBeGreaterThan(memo);
    // 那台电脑的来源 id 与被控电脑的不是一回事:先于被控电脑镜像判定。
    expect(mirror).toBeGreaterThan(agentDevice);
    expect(deviceLink).toBeGreaterThan(mirror);
    expect(local).toBeGreaterThan(deviceLink);
  });

  it('任务所在电脑那份记忆:被控电脑上的任务用它的镜像,本机任务用本机预设', () => {
    expect(chatInputSource).toContain(
      'const taskComputerModelMemory = deviceLinkDeviceId ? modelMemoryOverride : LOCAL_MODEL_MEMORY;',
    );
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

  it('按模型所在目录写档位:另一台电脑写那台的一份,任务所在电脑写那份(没有就不写)', () => {
    const helper = chatInputSource.indexOf('function rememberCatalogModelPrefs(');
    expect(helper).toBeGreaterThan(0);
    const body = chatInputSource.slice(helper, chatInputSource.indexOf('\n}\n', helper));
    expect(body).toContain(
      'const memory = deviceId ? agentDeviceModelMemoryAccessors(deviceId) : taskComputerMemory;',
    );
    expect(body).toContain('if (!memory) return;');
    expect(body).toContain('memory.setEffort(agent, providerId, modelId, patch.effort)');
    expect(body).toContain('memory.setFast(agent, providerId, modelId, patch.fast)');
  });

  it('Agent 在另一台电脑的任务:换模后意图期调档记进那台的记忆,不写新建任务记忆', () => {
    const start = chatInputSource.indexOf('const syncSessionDraftModelPrefs = useCallback(');
    expect(start).toBeGreaterThan(0);
    const agentDeviceBranch = chatInputSource.indexOf('if (agentDeviceId) {', start);
    const remember = chatInputSource.slice(agentDeviceBranch).search(
      /rememberCatalogModelPrefs\(\s*agentDeviceId,\s*agentKind,\s*memoryProviderId,\s*modelId,\s*patch,\s*taskComputerModelMemory,\s*\);/,
    );
    const localWrites = chatInputSource.indexOf('setProviderModelChoice(agentKind,', start);
    const remoteWrites = chatInputSource.indexOf("'maker:apply-new-maker-draft-pref'", start);
    expect(agentDeviceBranch).toBeGreaterThan(start);
    expect(remember).toBeGreaterThan(0);
    // 分支在本机写入、写穿被控电脑之前 return,不掺本机预设与两边的新建任务记忆。
    const earlyReturn = chatInputSource.indexOf('return;', agentDeviceBranch + remember);
    expect(earlyReturn).toBeGreaterThan(agentDeviceBranch + remember);
    expect(localWrites).toBeGreaterThan(earlyReturn);
    expect(remoteWrites).toBeGreaterThan(earlyReturn);
  });

  it('已有任务换电脑:档位记进目标电脑那份目录的记忆(改回任务所在电脑写那份)', () => {
    expect(chatInputSource).toContain(
      'rememberCatalogModelPrefs(relocateTo, targetAgentKind, providerId, newModelId, {',
    );
    expect(chatInputSource).toContain('}, taskComputerModelMemory);');
    expect(chatInputSource).toMatch(
      /rememberCatalogModelPrefs\(\s*relocateTo,\s*targetAgentKind,\s*syncedProviderId,\s*newModelId,\s*syncedPatch,\s*taskComputerModelMemory,\s*\)/,
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
