/** Native integration: real Chromium runs an unchanged main.js bridge while
 * origin, owner and process boundaries remain enforced. No Node VM or mocked
 * renderer can verify these properties. Select an installed browser explicitly. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HeadlessGhostSandbox } from './headlessSandbox.js';
import { GhostRuntime } from './GhostRuntime.js';
import type { InstalledGhost } from './shared/ghost.js';

const executablePath = process.env.CINDY_TEST_CHROMIUM;
let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'cindy-plugin-browser-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it.skipIf(!executablePath)('runs main.js in the real sandbox, preserves pipe identity, and revokes its owner', async () => {
  const received: Array<{ id: string; payload: any }> = [];
  let notify: (() => void) | undefined;
  let owner = true;
  await writeFile(path.join(root, 'main.js'), `
    cindy.onHostMessage(async message => {
      const ping = await cindy.ping();
      const blocked = await fetch('https://unreachable.invalid/value').then(() => false, () => true);
      await cindy.send({ type:'tool-result', callId: message.callId, result: {
        ping, blocked, node: typeof process, require: typeof require,
        kv: await fetch('/kv').then(response => response.json())
      }});
    });
    cindy.send({ type:'ready', api:typeof cindy.tasks.create });
  `);
  const ghost = { dir: root, enabled: true, namespace: null, approval: {state: 'approved', revision: '00000000-0000-4000-8000-000000000001'}, manifest: { schemaVersion: 2, id: 'fixture', name: 'Fixture', kind: 'chip', entry: 'main.js', version: '1.0.0', slots: ['tool'], tools: [{name:'probe',description:'Probe'}] } } as InstalledGhost;
  const adapter = new HeadlessGhostSandbox({ executablePath: executablePath!,
    mailRuntimeSource: await readFile(new URL('./mailComposeRuntime.js', import.meta.url), 'utf8'),
    capture: () => () => owner,
    receive: async (id, payload) => { received.push({ id, payload }); notify?.(); return {ok:true}; },
    request: async (_id, request) => new URL(request.url).pathname === '/kv' ? Response.json({ existing: true }) : null,
  });
  const runtime = new GhostRuntime({ adapter });
  const waitFor = async (type: string) => {
    if (received.some(row => row.payload.type === type)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing plugin reply: '+type)), 2000);
      notify = () => { if (received.some(row => row.payload.type === type)) { clearTimeout(timer); resolve(); } };
    });
  };
  try {
    expect(await runtime.spawn(ghost)).toEqual({ ok: true, state: 'running' });
    await waitFor('ready');
    expect(adapter.send('fixture', {type:'tool-call',callId:'actual-call'})).toBe(true);
    await waitFor('tool-result');
    expect(received.find(row => row.payload.type === 'tool-result')).toEqual({id:'fixture',payload:{type:'tool-result',callId:'actual-call',result:{ping:{ok:true,id:'fixture'},blocked:true,node:'undefined',require:'undefined',kv:{existing:true}}}});
    expect(received.find(row => row.payload.type === 'ready')?.payload.api).toBe('function');
    owner = false;
    expect(adapter.send('fixture', {type:'tool-call',callId:'late-call'})).toBe(false);
  } finally { runtime.destroyAll(); await adapter.close(); }
});
