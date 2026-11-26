import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const context = vi.hoisted(() => ({ root: '', owner: 'first', generation: 1, pending: false, workspaces: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: () => context.root } }));
vi.mock('../../logger.js', () => ({ createLogger: () => context.log }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => context.log } }));
vi.mock('../../appSessionState.js', () => ({
  peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: context.owner, generation: context.generation }),
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: context.owner, generation: context.generation }),
  activeOwnerScopeKey: () => `${context.owner}:${context.generation}`,
  isAppSessionBoundaryPending: () => context.pending,
  dataOwnerStorageKey: (id: string) => `test-${id}`,
  ownerScopedUserDataPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
}));
vi.mock('../../im/ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
}));

vi.mock('../readKnownWorkspaces.js', () => ({ readKnownWorkspaces: () => ({ knownWorkspaces: context.workspaces, knownWorkspacesComplete: false }) }));
import { nativeProjectToolSettings } from '../additionalProjectTools.js';
import { configureAdditionalNativeOperations } from '../additionalRuntime.js';
import { getHostSettings, updateHostSettings } from '../index.js';
import { SettingsReader } from '../../maker-host/plugins/settings-reader.js';
const caller = { id: 'fixture-session', assertCurrent() {} };
const read = (id?: string) => getHostSettings(caller, 'workspaceTools', id);
beforeEach(() => {
  context.root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-tool-settings-')); context.owner = 'first'; context.generation++; context.pending = false;
  context.workspaces = ['one','two'].map(name => path.join(context.root, name));
  configureAdditionalNativeOperations({ workspaceTools: nativeProjectToolSettings } as Parameters<typeof configureAdditionalNativeOperations>[0]);
  vi.clearAllMocks();
});
afterEach(() => fs.rmSync(context.root, { recursive: true, force: true }));
async function update(id: string, values: {set?: Record<string, unknown>; clear?: string[]}) {
  const state = await read(id);
  if (state.status !== 'ready' || !('operationId' in state)) throw new Error('fixture');
  return updateHostSettings(caller, { domain: 'workspaceTools', workspaceId: id, operationId: state.operationId, expectedRevision: state.revision, ...values });
}
function ready() { const state = nativeProjectToolSettings.read(); if (state.status !== 'ready') throw new Error('fixture'); return state; }
describe('workspace settings target and native persistence', () => {
  it('binds the opaque workspace target and inherited defaults to the issued revision', async () => {
    const first = ready(), second = nativeProjectToolSettings.read(first.choices.workspaceIds[1]!.value);
    expect(second.status).toBe('ready'); expect(second.revision).not.toBe(first.revision);
    const state = await read(first.workspaceId); if (state.status !== 'ready' || !('operationId' in state)) throw new Error('fixture');
    expect(await updateHostSettings(caller, { domain:'workspaceTools', workspaceId: first.choices.workspaceIds[1]!.value, operationId:state.operationId, expectedRevision:state.revision, set:{ssh:false} })).toMatchObject({saved:false,code:'CONFLICT'});
    expect(fs.readdirSync(context.root)).toEqual([]);
    const store = new SettingsReader({userDataPath:path.join(context.root,'owners','test-first'),logger:{warn(){}}});
    await store.commitUserDefaults({set:{ssh:false}});
    await expect(nativeProjectToolSettings.commit(first.workspaceId,{set:{docs:false},clear:[]},{expectedRevision:first.revision})).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('edits one project, preserves unknown and legacy entries, and resets only its override', async () => {
    const file=path.join(context.workspaces[0]!,'.claude','settings.json'); fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({permissions:{allow:['Read']},xdtMaker:{future:'keep',plugins:{ssh:{enabled:true,note:'keep'},custom:{enabled:false}}}}));
    const state=ready(); expect(await update(state.workspaceId,{set:{ssh:false}})).toMatchObject({saved:true});
    const native=new SettingsReader({logger:{warn(){}}}); expect(native.readProjectPluginSetting(context.workspaces[0]!,'ssh')).toBe(false);
    expect(native.readProjectPluginSetting(context.workspaces[1]!,'ssh')).toBeNull();
    expect(JSON.parse(fs.readFileSync(file,'utf8'))).toEqual({permissions:{allow:['Read']},xdtMaker:{future:'keep',builtinTools:{ssh:{enabled:false,note:'keep'},custom:{enabled:false}}}});
    expect(await update(state.workspaceId,{clear:['ssh']})).toMatchObject({saved:true});
    expect(native.readProjectPluginSetting(context.workspaces[0]!,'ssh')).toBeNull();
    expect(JSON.parse(fs.readFileSync(file,'utf8')).xdtMaker.builtinTools.custom).toEqual({enabled:false});
  });
  it('refuses an unknown workspace, missing scope and a target that disappeared', async () => {
    expect(await read('z'.repeat(43))).toMatchObject({status:'unavailable'});
    const state=await read(); if(state.status!=='ready'||!('operationId' in state))throw new Error('fixture');
    const input={domain:'workspaceTools' as const,operationId:state.operationId,expectedRevision:state.revision,set:{ssh:false}};
    await expect(updateHostSettings(caller,input)).rejects.toMatchObject({code:'INVALID_PARAMS'});
    const id=ready().workspaceId; context.workspaces=[];
    expect(await updateHostSettings(caller,{...input,workspaceId:id})).toMatchObject({saved:false});
    expect(fs.readdirSync(context.root)).toEqual([]);
  });
});
