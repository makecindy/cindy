import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

import { confirmAgentLocationForPick } from '@/session/sessionAgentSwitchConfirmation';

const source = ts.createSourceFile('screen.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'selectUnifiedComposerModel') {
    callback = (node.initializer as ts.CallExpression).arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(source);
const js = ts.transpileModule(`const select = ${callback!.getText(source)};`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const studioProviders = [{ id: 'studio-account' }];
function harness(
  confirmed = true,
  saved = true,
  session: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const state = { agent: 'codex', intent: null as any };
  const setModelSheetAgentKind = vi.fn((agent: string) => { state.agent = agent; });
  const writeSessionAgentSwitchIntent = vi.fn(async(intent:unknown)=>{if(saved) state.intent=intent;return saved;});
  const setComposerModel = vi.fn(async()=>saved);
  const confirmMobileSessionAgentSwitch = vi.fn(async()=>confirmed);
  // 换电脑确认:按 confirmed 点「换电脑运行」或「保持不变」。
  const relocationAlert = vi.fn((_title: string, _message?: string, buttons?: { onPress?: () => void }[]) => {
    buttons?.[confirmed ? 1 : 0]?.onPress?.();
  });
  const resolveAgentCapability = vi.fn(() => ({ supportsFastMode: true }));
  const env = {
    agentLocationMovable:true,
    remoteAgentCatalogs:[{ deviceId:'device-studio-mac', name:'工作室 Mac', status:'ready', providers:studioProviders }],
    remoteAgentDeviceName:(id:string)=>id === 'device-studio-mac' ? '工作室 Mac' : id,
    controlledComputerName:'Home Mac',
    confirmAgentLocationForPick:(input: Parameters<typeof confirmAgentLocationForPick>[0]) =>
      confirmAgentLocationForPick(input, relocationAlert),
    canUseRemoteSessionControls:true,
    currentSession:{effort:'low',fastMode:false,agentKind:'codex',model:'current-model',providerId:null,agentDeviceId:null,...session},controlBusy:false,
    composerDeviceProviders:{providers:[]}, resolveAgentCapability,
    normalizeMobileAgentCapabilities:(x:unknown)=>x, maker:{getCapabilities:async()=>({hasFastMode:true}),setEffort:vi.fn(),setFastMode:vi.fn()},
    deviceId:'device',deviceIdRef:{current:'device'},sessionAgentKind:'codex',sessionAgentSwitchSupported:true,
    confirmMobileSessionAgentSwitch,
    writeSessionAgentSwitchIntent,
    setModelSheetAgentKind, setComposerModel,sessionId:'session',
    runControlAction:async(action:()=>Promise<boolean>,patch:any)=>{const ok=await action();if(ok)state.intent=patch.agentSwitchIntent;return ok;},
    ...overrides,
  };
  const render = () => new Function(...Object.keys(env), 'agentSwitchIntent', `${js}; return select;`)(...Object.values(env),state.intent);
  return {
    state, render, setModelSheetAgentKind, writeSessionAgentSwitchIntent, setComposerModel,
    confirmMobileSessionAgentSwitch, relocationAlert, resolveAgentCapability,
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
it.each([[false,true],[true,false]])('does not change the browsed Harness on rejection (%s, %s)',async(confirmed,saved)=>{
  const h=harness(confirmed,saved);
  expect(await h.render()(config)).toBe(false);
  expect(h.setModelSheetAgentKind).not.toHaveBeenCalled();
  expect(h.state.intent).toBeNull();
});

// 远程 Agent:模型列表另列其他电脑的供应商。同一台电脑内换模型直接切,换到另一台电脑先确认、
// 再带 agentDeviceId(null = 被控电脑)。
const studio = { deviceId: 'device-studio-mac' };
const studioConfig = { ...config, agent: 'codex', providerId: 'studio-account' };
it('switches directly between models of the same computer', async () => {
  const h = harness(true, true, { agentDeviceId: 'device-studio-mac' });
  expect(await h.render()(studioConfig, studio)).toBe(true);
  expect(h.relocationAlert).not.toHaveBeenCalled();
  expect(h.writeSessionAgentSwitchIntent).not.toHaveBeenCalled();
  expect(h.setComposerModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'model', providerId: 'studio-account' }));
  // 能力按这一行所属电脑的目录核对。
  expect(h.resolveAgentCapability).toHaveBeenCalledWith(studioProviders, 'studio-account', 'model', 'codex');
});
it('asks before moving the Agent to another computer and registers the move', async () => {
  const h = harness();
  expect(await h.render()(studioConfig, studio)).toBe(true);
  expect(h.relocationAlert).toHaveBeenCalledTimes(1);
  expect(h.relocationAlert.mock.calls[0]?.[0]).toContain('工作室 Mac');
  expect(h.setComposerModel).not.toHaveBeenCalled();
  expect(h.writeSessionAgentSwitchIntent).toHaveBeenCalledWith({
    targetAgentKind: 'codex', model: 'model', providerId: 'studio-account', effort: 'high', fastMode: false,
    agentDeviceId: 'device-studio-mac',
  });
  // 已确认过的同一台:在那台的目录里改选不再问,继续带位置。
  expect(await h.render()({ ...studioConfig, modelId: 'other-model' }, studio)).toBe(true);
  expect(h.relocationAlert).toHaveBeenCalledTimes(1);
  expect(h.state.intent).toMatchObject({ model: 'other-model', agentDeviceId: 'device-studio-mac' });
});
it('keeps everything unchanged when the move is cancelled', async () => {
  const h = harness(false);
  expect(await h.render()(studioConfig, studio)).toBe(false);
  expect(h.writeSessionAgentSwitchIntent).not.toHaveBeenCalled();
  expect(h.setComposerModel).not.toHaveBeenCalled();
  expect(h.state.intent).toBeNull();
});
it('asks before moving a remote Agent back to the controlled computer', async () => {
  const h = harness(true, true, { agentDeviceId: 'device-studio-mac' });
  expect(await h.render()({ ...config, agent: 'codex' }, { deviceId: null })).toBe(true);
  expect(h.relocationAlert.mock.calls[0]?.[0]).toContain('Home Mac');
  expect(h.setComposerModel).not.toHaveBeenCalled();
  expect(h.writeSessionAgentSwitchIntent).toHaveBeenCalledWith(expect.objectContaining({
    targetAgentKind: 'codex', model: 'model', providerId: 'account', agentDeviceId: null,
  }));
});
it('confirms a cross-engine move to another computer only once', async () => {
  const h = harness();
  expect(await h.render()({ ...config, providerId: 'studio-account' }, studio)).toBe(true);
  expect(h.relocationAlert).toHaveBeenCalledTimes(1);
  expect(h.confirmMobileSessionAgentSwitch).not.toHaveBeenCalled();
  expect(h.state.intent).toMatchObject({ targetAgentKind: 'pi', agentDeviceId: 'device-studio-mac' });
  expect(h.state.agent).toBe('pi');
});
it('does not move the Agent when the controller may not change its location', async () => {
  // 共享任务访客 / 不支持切换 / 旧被控端:agentLocationMovable=false,只接受被控电脑的目录。
  const h = harness(true, true, {}, { agentLocationMovable: false });
  expect(await h.render()(studioConfig, studio)).toBe(false);
  expect(h.relocationAlert).not.toHaveBeenCalled();
  expect(h.writeSessionAgentSwitchIntent).not.toHaveBeenCalled();
  expect(await h.render()({ ...config, agent: 'codex' })).toBe(true);
  expect(h.setComposerModel).toHaveBeenCalled();
});
