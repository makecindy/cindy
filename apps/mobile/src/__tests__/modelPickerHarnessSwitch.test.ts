import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

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
function harness(confirmed = true, saved = true) {
  const state = { agent: 'codex', intent: null as any };
  const setModelSheetAgentKind = vi.fn((agent: string) => { state.agent = agent; });
  const env = {
    canUseRemoteSessionControls:true, currentSession:{effort:'low',fastMode:false},controlBusy:false,
    composerDeviceProviders:{providers:[]}, resolveAgentCapability:()=>({supportsFastMode:true}),
    normalizeMobileAgentCapabilities:(x:unknown)=>x, maker:{getCapabilities:async()=>({hasFastMode:true}),setEffort:vi.fn(),setFastMode:vi.fn()},
    deviceId:'device',deviceIdRef:{current:'device'},sessionAgentKind:'codex',sessionAgentSwitchSupported:true,
    confirmMobileSessionAgentSwitch:async()=>confirmed,
    writeSessionAgentSwitchIntent:async(intent:unknown)=>{if(saved) state.intent=intent;return saved;},
    setModelSheetAgentKind, setComposerModel:async()=>saved,sessionId:'session',
    runControlAction:async(action:()=>Promise<boolean>,patch:any)=>{const ok=await action();if(ok)state.intent=patch.agentSwitchIntent;return ok;},
  };
  const render = () => new Function(...Object.keys(env), 'agentSwitchIntent', `${js}; return select;`)(...Object.values(env),state.intent);
  return {state,render,setModelSheetAgentKind};
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
