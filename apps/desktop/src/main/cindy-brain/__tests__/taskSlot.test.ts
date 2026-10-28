import { describe, expect, it, vi } from 'vitest';
import { isPluginTeamPlanWithinBudget, PLUGIN_TEAM_PLAN_MAX_JSON_CHARS } from '../../../shared/pluginTasks.js';
import { handlePluginTaskRequest, validPluginTaskRequest } from '../taskSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { buildPluginMessage } from '../../../shared/pluginMessage.js';
import { parseUserContent } from '../../../renderer/lib/imageRef.js';
import { projectPersistedAgentFacingUserText } from '@cindy/maker-shared/agent-input-projection';

describe('plugin task pipe', () => {
  it('round-trips collapsed context with screenshots while model history retains the full material', () => {
    const message = buildPluginMessage('Look here', 'Window text and pointer coordinates', 'Attached context');
    const persisted = JSON.stringify({ ...message,
      images: [{ url: 'cindy-media://blobs/example.png', mimeType: 'image/png', originalName: 'window.png' }] });
    const parsed = parseUserContent(persisted);
    const range = parsed.pastedTextRanges![0]!;
    expect(parsed.text.slice(0, range.start).trim()).toBe('Look here');
    expect(parsed.text.slice(range.start, range.end)).toContain('Window text and pointer coordinates');
    expect(range.display).toBe('Attached context');
    expect(parsed.images).toHaveLength(1);
    expect(projectPersistedAgentFacingUserText(persisted)).toBe(message.text);
    expect(buildPluginMessage('Legacy text', undefined, 'Attached context')).toEqual({ text: 'Legacy text' });
  });
  // unit: Ping exposed capture diagnostics as prose and pinned every new task to
  // an emote label. Existing cases never exercised independent context/title mode.
  it('accepts bounded separate context and explicit automatic naming without weakening legacy requests', () => {
    const create = { type: 'tasks-request', kind: 'create', requestKey: 'new' };
    expect(validPluginTaskRequest({ ...create, autoTitle: true })).toBe(true);
    expect(validPluginTaskRequest(create)).toBe(false);
    expect(validPluginTaskRequest({ ...create, title: 'Chosen title' })).toBe(true);
    expect(validPluginTaskRequest({ ...create, autoTitle: true, title: 'Conflicting title' })).toBe(false);
    const send = { type: 'tasks-request', kind: 'send', taskId: 'task', requestKey: 'send', expectedRevision: 1, text: 'Look here' };
    expect(validPluginTaskRequest({ ...send, context: 'Window contents' })).toBe(true);
    expect(validPluginTaskRequest({ ...send, context: { system: 'not allowed' } })).toBe(false);
    expect(validPluginTaskRequest({ ...send, context: 'x'.repeat(32769) })).toBe(false);
  });
  it('bounds the complete JSON plan without truncating scope or breaking representative 200-item batches', () => {
    const item = {label:'sample',workingDir:'/answer',route:{agentKind:'pi',providerId:'p',model:'m',effort:'high',fastMode:false},task:'测'.repeat(2600)};
    const plan = {concurrency:4,task:'c'.repeat(8000),items:Array.from({length:200},(_,i)=>({...item,label:'w'+i}))};
    expect(validPluginTaskRequest({type:'tasks-request',kind:'setTeamPlan',taskId:'lead',plan})).toBe(true);
    expect(validPluginTaskRequest({type:'tasks-request',kind:'setTeamPlan',taskId:'lead',plan:{...plan,items:plan.items.map(x=>({...x,task:'x'.repeat(8000)}))}})).toBe(false);
    const room = PLUGIN_TEAM_PLAN_MAX_JSON_CHARS - JSON.stringify({task:''}).length;
    expect(isPluginTeamPlanWithinBudget({task:'x'.repeat(room)})).toBe(true);
    expect(isPluginTeamPlanWithinBudget({task:'x'.repeat(room+1)})).toBe(false);
    expect(isPluginTeamPlanWithinBudget({task:'\n'.repeat(room)})).toBe(false);
  });
  const ghost = { enabled: true, taskCapabilityApproved: true, approval: {state:'approved', revision:'r'}, manifest: { agent: { tasks: true } } } as InstalledGhost;
  // unit: the creation API must accept a permission choice, without accepting a
  // grant or a permission change on existing tasks. Legacy tests only omitted it.
  it('advertises and forwards supported creation permissions without granting authority', async () => {
    const handler = vi.fn(async () => ({ taskId: 'created' }));
    const deps = { getGhost: () => ghost, handler, isCurrent: () => true };
    const create = { type: 'tasks-request', kind: 'create', requestKey: 'new', title: 'Work' };
    expect(await handlePluginTaskRequest('p', { type: 'tasks-request', kind: 'capabilities' }, deps))
      .toMatchObject({ ok: true, data: { createPermissionMode: true } });
    for (const permissionMode of ['ask', 'auto', 'bypassPermissions']) {
      const request = { ...create, permissionMode };
      expect(await handlePluginTaskRequest('p', request, deps)).toMatchObject({ ok: true });
      expect(handler).toHaveBeenLastCalledWith('p', request);
    }
    for (const permissionMode of ['acceptEdits', 'plan', 'default', null, 1]) {
      expect(validPluginTaskRequest({ ...create, permissionMode })).toBe(false);
    }
    expect(validPluginTaskRequest({ ...create, permissionMode: 'auto', confirmed: true })).toBe(false);
    expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'send', taskId: 't', requestKey: 's',
      text: 'Continue', expectedRevision: 1, permissionMode: 'auto' })).toBe(false);
  });
  it('requires its own declared capability; errand alone grants nothing', async () => {
    const handler = vi.fn();
    const result = await handlePluginTaskRequest(
      'p',
      { type: 'tasks-request', kind: 'capabilities' },
      {
        getGhost: () => ({ ...ghost, manifest: { ...ghost.manifest, agent: { errand: true } } }),
        handler,
        isCurrent: () => true,
      },
    );
    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'tasks-request', kind: 'create', requestKey: 'a', title: 't', workingDir: '/private' },
    {
      type: 'tasks-request',
      kind: 'send',
      taskId: 's',
      requestKey: 'a',
      expectedRevision: 1,
      text: 'hi',
      permissionMode: 'bypassPermissions',
    },
    { type: 'tasks-request', kind: 'list', limit: 1000 },
    { type: 'tasks-request', kind: 'get', taskId: 's', ghostId: 'other' },
    { type: 'tasks-request', kind: '__proto__' },
  ])('rejects unsupported/identity/permission fields', (payload) =>
    expect(validPluginTaskRequest(payload)).toBe(false),
  );
  it('rechecks authorization after async work and redacts internal errors', async () => {
    let current = true;
    const result = await handlePluginTaskRequest(
      'p',
      { type: 'tasks-request', kind: 'get', taskId: 't' },
      {
        getGhost: () => ghost,
        isCurrent: () => current,
        handler: async () => {
          current = false;
          return 'secret';
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const error = await handlePluginTaskRequest(
      'p',
      { type: 'tasks-request', kind: 'get', taskId: 't' },
      {
        getGhost: () => ghost,
        isCurrent: () => true,
        handler: async () => {
          throw new Error('/sensitive/path');
        },
      },
    );
    expect(JSON.stringify(error)).not.toContain('/sensitive/path');
  });
});

it('write access can only ask the host for a task, never supply a permission grant',()=>{
 expect(validPluginTaskRequest({type:'tasks-request',kind:'requestWriteAccess',taskId:'own'})).toBe(true);
 for(const extra of [{permissionMode:'auto'},{confirmed:true},{ghostId:'other'}]){
  expect(validPluginTaskRequest({type:'tasks-request',kind:'requestWriteAccess',taskId:'own',...extra})).toBe(false);
 }
});

it('collaboration methods accept only an owned task identifier, not permission overrides',()=>{
 for(const kind of ['startTeam','getTeam']){
  expect(validPluginTaskRequest({type:'tasks-request',kind,taskId:'own'})).toBe(true);
  expect(validPluginTaskRequest({type:'tasks-request',kind,taskId:'own',workerPermissionMode:'auto'})).toBe(false);
 }
});

it('allows an Auto request but never Full access', () => {
 expect(validPluginTaskRequest({type:'tasks-request',kind:'requestWriteAccess',taskId:'own',mode:'auto'})).toBe(true);
 expect(validPluginTaskRequest({type:'tasks-request',kind:'requestWriteAccess',taskId:'own',mode:'bypassPermissions'})).toBe(false);
});

 it('accepts opt-in call context only for creation, never a claimed source session', () => {
   const create = { type: 'tasks-request', kind: 'create', requestKey: 'one', title: 'Work' };
   expect(validPluginTaskRequest({ ...create, callId: 'active-call' })).toBe(true);
   expect(validPluginTaskRequest({ ...create, sourceSessionId: 'foreign' })).toBe(false);
   expect(validPluginTaskRequest({ ...create, callId: '' })).toBe(false);
   expect(validPluginTaskRequest({ ...create, route: { agentKind: 'pi', providerId: 'mine', model: 'no-reasoning', effort: '', fastMode: false } })).toBe(true);
 });

it('exposes catalog and guarded model changes without accepting permission overrides', () => {
  expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'models' })).toBe(true);
  const request = { type: 'tasks-request', kind: 'setModel', taskId: 'own', expectedRevision: 1,
    route: { agentKind: 'codex', model: 'm', providerId: 'p', effort: '', fastMode: false } };
  expect(validPluginTaskRequest(request)).toBe(true);
  expect(validPluginTaskRequest({ ...request, route: 'plugin-default' })).toBe(true);
  expect(validPluginTaskRequest({ ...request, route: 'plugin-default', expectedRevision: undefined })).toBe(false);
  expect(validPluginTaskRequest({ ...request, route: 'plugin-default', ghostId: 'other' })).toBe(false);
  expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'create', requestKey: 'one', title: 'Work', route: 'plugin-default' })).toBe(false);
  expect(validPluginTaskRequest({ ...request, expectedRevision: undefined })).toBe(false);
  expect(validPluginTaskRequest({ ...request, permissionMode: 'bypassPermissions' })).toBe(false);
});

it('accepts bounded plugin-authored scope, never caller-supplied authority', () => {
 const item={label:'sample',workingDir:'/answer',route:{agentKind:'pi',providerId:'p',model:'m',effort:'high',fastMode:false},task:'Run tests'};
 const request={type:'tasks-request',kind:'setTeamPlan',taskId:'lead',plan:{concurrency:null,task:'Coordinate',items:[item]}};
 expect(validPluginTaskRequest(request)).toBe(true);
 expect(validPluginTaskRequest({...request,plan:{...request.plan,ownerApproved:true}})).toBe(false);
 expect(validPluginTaskRequest({...request,plan:{...request.plan,items:[{...item,task:'x'.repeat(8001)}]}})).toBe(false);
});

describe('background tasks (agent.hiddenTasks)', () => {
  const declared = { enabled: true, taskCapabilityApproved: true, approval: {state:'approved', revision:'r'},
    manifest: { agent: { tasks: true, hiddenTasks: true } } } as InstalledGhost;
  const undeclared = { ...declared, manifest: { agent: { tasks: true } } } as InstalledGhost;
  const create = { type: 'tasks-request', kind: 'create', requestKey: 'one', title: 'Work' };

  it('validates hidden on create and the setHidden operation shape', () => {
    expect(validPluginTaskRequest({ ...create, hidden: true })).toBe(true);
    expect(validPluginTaskRequest({ ...create, hidden: false })).toBe(true);
    expect(validPluginTaskRequest({ ...create, hidden: 'yes' })).toBe(false);
    expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'setHidden', taskId: 'own', hidden: false })).toBe(true);
    expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'setHidden', taskId: 'own' })).toBe(false);
    expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'setHidden', hidden: true })).toBe(false);
    expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'setHidden', taskId: 'own', hidden: true, sessionId: 'other' })).toBe(false);
    expect(validPluginTaskRequest({ type: 'tasks-request', kind: 'get', taskId: 'own', hidden: true })).toBe(false);
  });

  it('denies hidden creation and setHidden without the declaration, before reaching the handler', async () => {
    const handler = vi.fn(async () => ({ taskId: 't' }));
    const deps = { getGhost: () => undeclared, handler, isCurrent: () => true };
    for (const payload of [
      { ...create, hidden: true },
      { type: 'tasks-request', kind: 'setHidden', taskId: 't', hidden: true },
      { type: 'tasks-request', kind: 'setHidden', taskId: 't', hidden: false },
    ]) {
      expect(await handlePluginTaskRequest('p', payload, deps)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    }
    expect(handler).not.toHaveBeenCalled();
    // hidden:false is the default and remains available to every tasks plugin.
    expect(await handlePluginTaskRequest('p', { ...create, hidden: false }, deps)).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards declared requests and advertises the operation and declaration', async () => {
    const handler = vi.fn(async () => ({ taskId: 't', hidden: true }));
    const deps = { getGhost: () => declared, handler, isCurrent: () => true };
    expect(await handlePluginTaskRequest('p', { type: 'tasks-request', kind: 'setHidden', taskId: 't', hidden: true }, deps))
      .toEqual({ ok: true, data: { taskId: 't', hidden: true } });
    const caps = await handlePluginTaskRequest('p', { type: 'tasks-request', kind: 'capabilities' }, deps);
    expect(caps).toMatchObject({ ok: true, data: { hiddenTasks: true } });
    expect((caps as { data: { operations: string[] } }).data.operations).toContain('setHidden');
    const plain = await handlePluginTaskRequest('p', { type: 'tasks-request', kind: 'capabilities' }, { ...deps, getGhost: () => undeclared });
    expect(plain).toMatchObject({ ok: true, data: { hiddenTasks: false } });
  });

  it('does not grant hidden tasks from an unpaired historical value', async () => {
    const handler = vi.fn();
    const legacy = { ...declared, manifest: { agent: { tasks: true, hiddenTasks: 'yes' } } } as unknown as InstalledGhost;
    expect(await handlePluginTaskRequest('p', { ...create, hidden: true }, { getGhost: () => legacy, handler, isCurrent: () => true }))
      .toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(handler).not.toHaveBeenCalled();
  });
});
