import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

import { resolveAgentLocationPick } from '@/session/sessionAgentSwitch';

const source = ts.createSourceFile('screen.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
const callbackNames = ['loadComposerAgentCapabilities', 'canStageModelWindowSelection', 'selectUnifiedComposerModel'];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && callbackNames.includes(node.name.getText(source))) {
    callbacks.set(node.name.getText(source), (node.initializer as ts.CallExpression).arguments[0].getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const js = ts.transpileModule(callbackNames.map(name => `const ${name} = ${callbacks.get(name)};`).join('\n'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const studioProviders = [{ id: 'studio-account' }];
function harness(
  saved = true,
  session: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const state = { agent: 'codex', intent: null as any };
  const setModelSheetAgentKind = vi.fn((agent: string) => { state.agent = agent; });
  const writeSessionAgentSwitchIntent = vi.fn(async(intent:unknown)=>{if(saved) state.intent=intent;return saved;});
  const setComposerModel = vi.fn(async()=>saved);
  const resolveAgentCapability = vi.fn(() => ({ supportsFastMode: true }));
  const getCapabilities = vi.fn(async () => ({ hasFastMode: true }));
  const getRemoteCapabilities = vi.fn(async () => ({ hasFastMode: true }));
  const executionMakerForDevice = vi.fn((_deviceId: string) => ({ getCapabilities: getRemoteCapabilities }));
  const env = {
    // These fixtures exercise ordinary tasks; Orca admission has its own suite.
    hostSupportsRemoteModelWindowRebuild:false, modelSelectionUsesWindowIntent:false, orcaModelSelectionUsesIntent:false,orcaRemoteAgentDeviceId:null,executionMakerForDevice,
    isProviderShareAgentDeviceId:(id:unknown)=>typeof id === 'string' && id.startsWith('share:'),
    agentLocationMovable:true,
    remoteAgentCatalogs:[{ deviceId:'device-studio-mac', name:'工作室 Mac', status:'ready', providers:studioProviders }],
    resolveAgentLocationPick,
    canUseRemoteSessionControls:true,
    currentSession:{effort:'low',fastMode:false,agentKind:'codex',model:'current-model',providerId:null,agentDeviceId:null,...session},controlBusy:false,
    composerDeviceProviders:{providers:[]}, resolveAgentCapability,
    normalizeMobileAgentCapabilities:(x:unknown)=>x, maker:{getCapabilities,setEffort:vi.fn(),setFastMode:vi.fn()},
    deviceId:'device',deviceIdRef:{current:'device'},sessionAgentKind:'codex',sessionAgentSwitchSupported:true,
    writeSessionAgentSwitchIntent,
    setModelSheetAgentKind, setComposerModel,sessionId:'session',
    runControlAction:async(action:()=>Promise<boolean>,patch:any)=>{const ok=await action();if(ok)state.intent=patch.agentSwitchIntent;return ok;},
    ...overrides,
  };
  const render = () => new Function(...Object.keys(env), 'agentSwitchIntent', `${js}; return selectUnifiedComposerModel;`)(...Object.values(env),state.intent);
  return {
    state, render, setModelSheetAgentKind, writeSessionAgentSwitchIntent, setComposerModel,
    resolveAgentCapability,
    getCapabilities, getRemoteCapabilities, executionMakerForDevice,
  };
}
const config = {agent:'pi',providerId:'account',modelId:'model',effort:'high',fast:false};
it('keeps the new Harness for subsequent effort/Fast edits and switches back on success',async()=>{
  const h=harness();
  expect(await h.render()(config)).toBe(true);
  expect(h.state.agent).toBe('pi');
  expect(await h.render()({...config,agent:h.state.agent,effort:'max',fast:true})).toBe(true);
  expect(h.state.intent).toMatchObject({targetAgentKind:'pi',effort:'max',fastMode:true});
  expect(await h.render()({...config,agent:'codex'})).toBe(true);
  expect(h.state.agent).toBe('codex');
  expect(h.state.intent).toBeNull();
});
it('does not change the browsed Harness when intent registration fails', async () => {
  const h = harness(false);
  expect(await h.render()(config)).toBe(false);
  expect(h.setModelSheetAgentKind).not.toHaveBeenCalled();
  expect(h.state.intent).toBeNull();
});

// Unit: 按 2026-11-18 裁决，生产选择回调点选即登记换机意图，且不会立刻改模型。
// 单测只需当前本机任务和一行另一台电脑的模型，单纯的设备判定测试无法覆盖登记时机。
const studio = { deviceId: 'device-studio-mac' };
const studioConfig = { ...config, agent: 'codex', providerId: 'studio-account' };
it('switches directly between models of the same computer', async () => {
  const h = harness(true, { agentDeviceId: 'device-studio-mac' });
  expect(await h.render()(studioConfig, studio)).toBe(true);
  expect(h.writeSessionAgentSwitchIntent).not.toHaveBeenCalled();
  expect(h.setComposerModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'model', providerId: 'studio-account' }));
  // 能力按这一行所属电脑的目录核对。
  expect(h.resolveAgentCapability).toHaveBeenCalledWith(studioProviders, 'studio-account', 'model', 'codex');
  expect(h.executionMakerForDevice).toHaveBeenCalledWith(studio.deviceId);
  expect(h.getRemoteCapabilities).toHaveBeenCalledWith('codex');
  expect(h.getCapabilities).not.toHaveBeenCalled();
});
it('registers the selected computer for the next message without changing the running model', async () => {
  const h = harness();
  expect(await h.render()(studioConfig, studio)).toBe(true);
  expect(h.setComposerModel).not.toHaveBeenCalled();
  expect(h.writeSessionAgentSwitchIntent).toHaveBeenCalledWith({
    targetAgentKind: 'codex', model: 'model', providerId: 'studio-account', effort: 'high', fastMode: false,
    agentDeviceId: 'device-studio-mac',
  });
  // 改选同一台电脑上的另一个模型，意图仍带这台电脑。
  expect(await h.render()({ ...studioConfig, modelId: 'other-model' }, studio)).toBe(true);
  expect(h.state.intent).toMatchObject({ model: 'other-model', agentDeviceId: 'device-studio-mac' });
});
it('clears the pending move when the user picks a model on the original computer', async () => {
  const h = harness();
  expect(await h.render()(studioConfig, studio)).toBe(true);
  expect(await h.render()({ ...config, agent: 'codex' }, { deviceId: null })).toBe(true);
  expect(h.writeSessionAgentSwitchIntent).toHaveBeenCalledTimes(1);
  expect(h.setComposerModel).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'account' }));
  expect(h.state.intent).toBeNull();
});
it('registers a move back to the controlled computer', async () => {
  const h = harness(true, { agentDeviceId: 'device-studio-mac' });
  expect(await h.render()({ ...config, agent: 'codex' }, { deviceId: null })).toBe(true);
  expect(h.setComposerModel).not.toHaveBeenCalled();
  expect(h.writeSessionAgentSwitchIntent).toHaveBeenCalledWith(expect.objectContaining({
    targetAgentKind: 'codex', model: 'model', providerId: 'account', agentDeviceId: null,
  }));
  expect(h.getCapabilities).toHaveBeenCalledWith('codex');
  expect(h.getRemoteCapabilities).not.toHaveBeenCalled();
});
it('registers a single intent for a combined Harness and computer switch', async () => {
  const h = harness();
  expect(await h.render()({ ...config, providerId: 'studio-account' }, studio)).toBe(true);
  expect(h.writeSessionAgentSwitchIntent).toHaveBeenCalledTimes(1);
  expect(h.setComposerModel).not.toHaveBeenCalled();
  expect(h.state.intent).toMatchObject({ targetAgentKind: 'pi', agentDeviceId: 'device-studio-mac' });
  expect(h.state.agent).toBe('pi');
});
it('does not move the Agent when the controller may not change its location', async () => {
  // 共享任务访客 / 不支持切换 / 旧被控端:agentLocationMovable=false,只接受被控电脑的目录。
  const h = harness(true, {}, { agentLocationMovable: false });
  expect(await h.render()(studioConfig, studio)).toBe(false);
  expect(h.writeSessionAgentSwitchIntent).not.toHaveBeenCalled();
  expect(await h.render()({ ...config, agent: 'codex' })).toBe(true);
  expect(h.setComposerModel).toHaveBeenCalled();
});
