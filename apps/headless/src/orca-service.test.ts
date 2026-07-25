import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HeadlessSessionStorage } from './session-storage.js';
import { HeadlessOrcaService } from './orca-service.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';

describe('HeadlessOrcaService', () => {
  let storage: HeadlessSessionStorage | undefined;
  let orca: HeadlessOrcaService | undefined;

  afterEach(() => {
    orca?.close();
    storage?.close();
  });

  it('persists a lead and workers while all work runs through the shared runtime', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-orca-'));
    storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const calls: string[] = [];
    const runtime: HeadlessSessionRuntime = {
      send: async (session, content) => { calls.push(`${session.id}:${String(content)}`); },
      steer: async () => undefined,
      abort: async () => undefined,
      closeSession: async () => undefined,
      resolveInteraction: async () => false,
      reconfigure: async () => undefined,
      setOrcaRole: async () => undefined,
      isSessionBusy: () => false,
      isAnySessionBusy: () => false,
      close: async () => undefined,
    };
    orca = new HeadlessOrcaService(path.join(dir, 'sessions.db'), storage, runtime);
    const lead = await storage.create({
      id: 'lead', agentKind: 'codex', workDir: '/work', workspaceKind: 'project', title: 'Lead', model: 'gpt-5.6', permissionMode: 'ask',
    });

    const team = await orca.startTeam(lead.id);
    expect(team.status).toBe('active');
    expect((await storage.get(lead.id))?.orcaRole).toBe('lead');
    const worker = await orca.createWorker({ leadSessionId: lead.id, label: 'api', role: 'developer', initialTask: 'Implement API' });
    expect(worker.status).toBe('running');
    expect((await storage.get(worker.sessionId))?.orcaRole).toBe('worker');
    expect(calls).toEqual([`${worker.sessionId}:Implement API`]);

    await storage.appendEvent(worker.sessionId, 'agent_event', { type: 'done', data: {} });
    await Promise.resolve();
    expect(orca.listWorkers(lead.id)[0]?.status).toBe('done');
    await expect(orca.createWorker({ leadSessionId: lead.id, label: 'API', role: 'duplicate' })).rejects.toThrow('already exists');

    await orca.endTeam(lead.id);
    expect(orca.listWorkers(lead.id)).toEqual([]);
    expect((await storage.get(lead.id))?.orcaRole).toBeUndefined();
  });
});
