/**
 * newMakerGenericCreatePreservesDraft.test.ts
 * ---------------------------------------------------------------------------
 * 回归(2026-07 → 2026-08):通用「新建」入口不得在侧栏手写第二份草稿状态。
 *
 * 背景:草稿页(/cc-agent/new)的「对话或选择项目」选择由 newMakerDraft store
 * 持久化。此前展开态 SidebarTopNav.handleNew 与折叠态 CCAgentSidebarUpper.handleNewCCS
 * 都会先重置 newMakerDraft 再 navigate,导致用户选择被意外清空。现在有当前任务时,
 * 入口携带一次性种子请求;没有当前任务时才回落 newMakerDraft 的持久偏好。目标与
 * 授权清理仍由 NewMakerDraftRoute 集中处理。
 *
 * 静态扫描风格(renderer 测试环境无 jsdom),与 sidebarUpperSingleButton.test.ts 一致。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const topNavSource = readFileSync(
  resolve(__dirname, '..', 'components', 'sidebar', 'SidebarTopNav.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const sidebarUpperSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const draftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const newMakerHookSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'useNewMakerFromActiveSession.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

/** 抽出某个 handler 的实现体(从 `const <name> =` 到该 handler 结束的 `}, [` / `};`)。 */
function extractHandlerBlock(source: string, name: string): string {
  const re = new RegExp(`const ${name}\\s*=\\s*[\\s\\S]*?(?:\\}, \\[|\\};)`);
  const match = source.match(re);
  expect(match, `expected to find handler ${name}`).not.toBeNull();
  return match![0];
}

describe('通用「新建」以当前任务为一次性种子', () => {
  it('展开态 SidebarTopNav.handleNew 走统一种子入口', () => {
    const block = extractHandlerBlock(topNavSource, 'handleNew');
    expect(block).toContain('startNewMakerFromActiveSession();');
    // 通用入口不再需要 patchDraft/patchNewMakerDraft,连 value import 都应移除。
    expect(topNavSource).not.toContain("from '@/state/newMakerDraft'");
  });

  it('折叠态 CCAgentSidebarUpper.handleNewCCS 与展开态同源', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleNewCCS');
    expect(block).toContain('startNewMakerFromActiveSession();');
  });

  it('Orca 兼容路由也能解析当前任务作为种子来源', () => {
    expect(newMakerHookSource).toContain("useMatch('/cc-agent/orca/:sessionId')");
    expect(newMakerHookSource).toContain("useMatch('/cc-agent/files/:sessionId')");
    expect(newMakerHookSource).toContain(
      'orcaSessionMatch?.params.sessionId\n    ?? filesSessionMatch?.params.sessionId\n    ?? sessionMatch?.params.sessionId',
    );
  });

  it('会话桶尚未加载时按当前任务 id 精确拉取种子', () => {
    expect(newMakerHookSource).toContain('getSessionFor(sourceSessionId)');
    expect(newMakerHookSource).toContain('navigateGeneric();');
    expect(sidebarUpperSource).toContain('getSessionFor(sourceSessionId)');
    expect(newMakerHookSource).toContain(
      'fallbackNavigationEpochRef.current !== fallbackNavigationEpoch',
    );
    expect(newMakerHookSource).toContain('activeSessionIdRef.current !== sourceSessionId');
    expect(sidebarUpperSource).toContain('viewedSessionIdRef.current !== sourceSessionId');
  });

  it('显式「新建对话」入口仍清空 workingDir,但由创建页集中迁移目标', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleCreateDialogue');
    // 2026-08-12 起 handler 接受可选的显式设备目标(按设备分组时对话组给出所属设备);
    // 未给时仍按当前机器作用域推断,route state 由统一的 target 变量组装。
    expect(block).toContain('state: makeSeededDialogueRouteState(sourceSession, target)');
    expect(block).toContain('target = selectedDialogueDeviceResolution.target;');
    expect(block).toContain("selectedDialogueDeviceResolution.status === 'pending'");
    expect(block).not.toContain('resetDraftWorkspaceTargets');
    expect(draftRouteSource).toMatch(
      /applyDraftTarget\(\{\s*deviceId: dialogueTargetRequest\.deviceId,\s*deviceName: dialogueTargetRequest\.deviceName,\s*workingDir: null,/,
    );
  });

  it('文件浏览路由也能为显式「新建对话」解析当前任务', () => {
    expect(sidebarUpperSource).toContain(
      'remoteProjectSessions.find((session) => session.id === viewedSessionId)',
    );
    expect(sidebarUpperSource).toContain(
      'sessions.find((session) => session.id === viewedSessionId)',
    );
  });

  it('NewMakerDraftRoute 集中消费当前任务种子并清掉一次性协同选择', () => {
    expect(draftRouteSource).toContain('readNewMakerSessionTargetRequest(location.state)');
    expect(draftRouteSource).toContain('consumeNewMakerSessionTargetRequest(location.state)');
    expect(draftRouteSource).toMatch(/patchVendorPrefs\(runtime\.vendor,/);
    expect(draftRouteSource).toContain('patchCollab({ enabled: false });');
    expect(draftRouteSource).not.toContain('extraDirs: sessionTargetRequest');
  });

  it('本地任务种子同步覆盖 provider-model 权威偏好层', () => {
    expect(draftRouteSource).toContain(
      'if (localProvidersLoading && sessionTargetRequest.runtime && !sessionTargetRequest.deviceId)',
    );
    expect(draftRouteSource).toContain(
      'effectiveSourceIdForModel(\n        getTargetCalibrationProviders(localProviders, agentKind, request.remoteHostId ?? null),\n        runtime.providerId ?? null,\n        runtime.model,\n        agentKind,\n      );',
    );
    expect(draftRouteSource).toContain(
      'setProviderModelEffort(agentKind, providerId, runtime.model, runtime.effort);',
    );
    expect(draftRouteSource).toContain(
      'setProviderModelFast(agentKind, providerId, runtime.model, runtime.fastMode);',
    );
    expect(draftRouteSource.indexOf('setProviderModelEffort(agentKind'))
      .toBeGreaterThan(draftRouteSource.indexOf('patchVendorPrefs(runtime.vendor,'));
    expect(draftRouteSource.indexOf('setProviderModelEffort(agentKind')).toBeGreaterThan(
      draftRouteSource.indexOf('setPendingSessionTarget(sessionTargetRequest);'),
    );
    expect(draftRouteSource).toContain(
      'getTargetCalibrationProviders(localProviders, agentKind, request.remoteHostId ?? null)',
    );
  });

  it('device-link 种子按远端能力透传计划模式', () => {
    expect(draftRouteSource).toContain('planMode: runtime.planMode,');
    expect(draftRouteSource).toContain(
      'const effectivePlanMode = isDeviceLinkDraft\n    ? deviceLinkInitial?.planMode === true\n    : chatPrefs.planMode === true;',
    );
    expect(draftRouteSource).toContain('planMode: effectivePlanMode,');
  });

  it('远端种子请求会被引擎与设备切换作废', () => {
    expect(draftRouteSource).toContain(
      'if (deviceChanged) modePickerSelectionSeqRef.current += 1;',
    );
    const block = extractHandlerBlock(draftRouteSource, 'handleVendorChange');
    expect(block).toContain('modePickerSelectionSeqRef.current += 1;');
    expect(block).toContain('dlRuntimeTouchedRef.current = true;');
  });

  it('远端模型与能力重校准保留继承的计划模式', () => {
    expect(draftRouteSource.match(/planMode: prev.planMode/g)).toHaveLength(2);
    expect(draftRouteSource.match(/planMode: previous.planMode/g)).toHaveLength(1);
  });

  it('device-link 任务快照必须替换同设备默认值并补齐缓存', () => {
    expect(draftRouteSource).toContain('replaceRemoteRuntime: true');
    expect(draftRouteSource).toContain(
      'if (deviceChanged || req.replaceRemoteRuntime === true) {',
    );
    expect(draftRouteSource).toContain('remoteDraftRevisionRef.current += 1;');
    expect(draftRouteSource).toContain(
      'if (deviceChanged) skipDefaultsRefetchRef.current = true;',
    );

    const snapshotAt = draftRouteSource.indexOf('replaceRemoteRuntime: true');
    for (const call of [
      'prefetchDeviceCapabilities(deviceId)',
      'prefetchDeviceProviders(deviceId)',
      'prefetchDeviceGitSafetySettings(deviceId)',
    ]) {
      expect(draftRouteSource.indexOf(call)).toBeGreaterThan(snapshotAt);
    }
  });

  // 保留与清空的分界(2026-07-25 用户定稿):workingDir / 文本 / 模型是便利性
  // 记忆,通用「新建」保留;extraDirs 是单次授权范围,每次进入草稿页必须从空开始
  //(否则旧目录会无感知地带进新会话)。清空由 NewMakerDraftRoute mount 效果承担,
  // 通用入口依旧不 patch store(前两条断言不受影响)。
  it('NewMakerDraftRoute mount 时清空 extraDirs(引用目录不跨草稿保留)', () => {
    expect(draftRouteSource).toContain(
      "if (getDraft().extraDirs.length > 0) patchDraft({ extraDirs: [] });",
    );
  });
});
