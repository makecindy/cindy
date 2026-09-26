import { describe, expect, it, vi } from 'vitest';
import { handlePluginTaskRequest, validPluginTaskRequest } from '../taskSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

describe('plugin task pipe', () => {
  const ghost = { enabled: true, manifest: { agent: { tasks: true } } } as InstalledGhost;
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

it('accepts bounded plugin-authored scope, never caller-supplied authority', () => {
 const item={label:'sample',workingDir:'/answer',route:{agentKind:'pi',providerId:'p',model:'m',effort:'high',fastMode:false},task:'Run tests'};
 const request={type:'tasks-request',kind:'setTeamPlan',taskId:'lead',plan:{concurrency:null,task:'Coordinate',items:[item]}};
 expect(validPluginTaskRequest(request)).toBe(true);
 expect(validPluginTaskRequest({...request,plan:{...request.plan,ownerApproved:true}})).toBe(false);
 expect(validPluginTaskRequest({...request,plan:{...request.plan,items:[{...item,task:'x'.repeat(8001)}]}})).toBe(false);
});
