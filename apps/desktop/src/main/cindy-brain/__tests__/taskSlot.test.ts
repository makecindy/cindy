import { describe, expect, it, vi } from 'vitest';
import { handlePluginTaskRequest, validPluginTaskRequest } from '../taskSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

describe('plugin task pipe', () => {
  const ghost = { enabled: true, taskCapabilityApproved: true, approval: {state:'approved', revision:'r'}, manifest: { agent: { tasks: true } } } as InstalledGhost;
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
  expect(validPluginTaskRequest({ ...request, expectedRevision: undefined })).toBe(false);
  expect(validPluginTaskRequest({ ...request, permissionMode: 'bypassPermissions' })).toBe(false);
});
