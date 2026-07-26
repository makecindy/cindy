import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessConfigStore } from './config.js';
import { HeadlessControlService } from './control-service.js';
import { ControlSocketServer, requestControl, subscribeSessionEvents } from './control-socket.js';
import { HeadlessSessionStorage } from './session-storage.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('ControlSocketServer', () => {
  it('serves a single JSON control request over a private Unix socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-socket-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const service = new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json')));
    const server = new ControlSocketServer(path.join(dir, 'control.sock'), service, storage);
    await server.start();

    await expect(requestControl(path.join(dir, 'control.sock'), { id: 'ping', method: 'daemon.ping' }))
      .resolves.toEqual({ id: 'ping', ok: true, result: { ok: true } });

    await server.stop();
    storage.close();
  });

  it('replays persisted events then forwards later events on a session stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-stream-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '', title: 'Stream', model: 'gpt-5.4' });
    await storage.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'replay' } });
    const server = new ControlSocketServer(path.join(dir, 'control.sock'), new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json'))), storage);
    await server.start();

    const received: string[] = [];
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    let live!: () => void;
    const livePromise = new Promise<void>((resolve) => { live = resolve; });
    const subscription = subscribeSessionEvents(path.join(dir, 'control.sock'), 's1', 0, {
      onReady: ready,
      onEvent: (event) => {
        received.push((event.data as { data?: { text?: string } }).data?.text ?? '');
        if (received.includes('live')) live();
      },
      onDisconnect: (error) => { throw error ?? new Error('stream disconnected'); },
    });
    await readyPromise;
    await storage.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'live' } });
    await livePromise;
    expect(received).toEqual(['replay', 'live']);
    subscription.close();
    await server.stop();
    storage.close();
  });
});
