import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');

describe('SkillHub local-state IPC subscriptions', () => {
  it('shares one IPC listener and removes it after HMR-style disposal', () => {
    const start = source.indexOf('type FanOut =');
    const end = source.indexOf('// Stage 2 C1:', start);
    const compiled = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const ipc = { on: vi.fn(), removeListener: vi.fn() };
    const create = new Function('ipcRenderer', `${compiled}\nreturn createIpcFanOut;`)(ipc);
    const subscribe = create('skillhub:local-state-changed');
    const oldStore = vi.fn();
    const composer = vi.fn();
    const disposeStore = subscribe(oldStore);
    const disposeComposer = subscribe(composer);
    expect(ipc.on).toHaveBeenCalledTimes(1);
    ipc.on.mock.calls[0][1]({});
    expect(oldStore).toHaveBeenCalledOnce();
    expect(composer).toHaveBeenCalledOnce();
    disposeStore();
    const newStore = vi.fn();
    const disposeNew = subscribe(newStore);
    ipc.on.mock.calls[0][1]({});
    expect(oldStore).toHaveBeenCalledOnce();
    expect(newStore).toHaveBeenCalledOnce();
    disposeComposer();
    disposeNew();
    expect(ipc.removeListener).toHaveBeenCalledWith('skillhub:local-state-changed', ipc.on.mock.calls[0][1]);
    expect(source).toContain("const fanOutSkillhubLocalStateChanged = createIpcFanOut('skillhub:local-state-changed')");
    expect(source).toContain('onLocalStateChanged: fanOutSkillhubLocalStateChanged');
  });
});
