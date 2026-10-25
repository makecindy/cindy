import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ParentPortLike } from './nodeWorker.js';
import { createControlPort } from './controlPort.js';
import { GHOST_NODE_CHILD_MODE_FLAG } from './nodeProtocol.js';
import type { NodeWorkerProcess, NodeWorkerStartupObservation } from './processTypes.js';

export interface NativeNodeWorkerOptions {
  /** The installed host's bundled Node, never an Electron executable. */
  nodePath: string;
  /** Built CJS bootstrap; loading plugins remains in a separate process. */
  workerPath: string;
}

/** Native counterpart of Desktop's utilityProcess adapter. The caller remains
 * responsible for the existing broker's install approval and owner checks. */
export function createNativeNodeWorkerProcess(
  options: NativeNodeWorkerOptions, entryPath: string, _cwd: string,
  ghostId: string, childArgs?: string[],
): NodeWorkerProcess {
  if (![options.nodePath, options.workerPath, entryPath].every(value => path.isAbsolute(value))) throw new Error('PLUGIN_WORKER_PATH_INVALID');
  // Windows anonymous extra stdio handles are not reliable duplex sockets.
  // Use a per-worker named pipe there, preserving the same private wire frames.
  if (process.platform === 'win32') return createWindowsNodeWorker(options, entryPath, ghostId, childArgs);
  const env: NodeJS.ProcessEnv = { CINDY_GHOST_ID: ghostId };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const isChild = childArgs !== undefined;
  const child = spawn(options.nodePath, [options.workerPath, entryPath, ...(isChild ? [GHOST_NODE_CHILD_MODE_FLAG, ...childArgs] : [])], {
    cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  const controls = new Set<(value: unknown) => void>();
  const observers = new Set<(value: NodeWorkerStartupObservation) => void>();
  let observation: NodeWorkerStartupObservation | undefined;
  let killed = false, destroyed = false, ready = false, messageCount = 0;
  const port = createControlPort(child.stdio[3] as Duplex, () => { child.kill(); });
  port.on('message', ({ data }) => {
    messageCount++;
    if (!ready && data && typeof data === 'object' && (data as { type?: unknown }).type === 'ready') {
      ready = true; events.emit('spawn'); return;
    }
    if (ready && !isChild) for (const listener of controls) listener(data);
  });
  child.on('spawn', () => {
    observation = { stage: 'utility-process-spawned', ...(child.pid ? { pid: child.pid } : {}) };
    for (const listener of observers) { try { listener(observation); } catch { /* diagnostics only */ } }
  });
  child.on('exit', (code, signal) => { destroyed = true; killed = true; events.emit('exit', code, signal); });
  child.on('error', error => { destroyed = true; events.emit('error', error); });
  const adapter: NodeWorkerProcess = {
    stdin: {
      get destroyed() { return destroyed; },
      write(chunk: string) {
        if (destroyed) return false;
        try { port.postMessage({ type: isChild ? 'stdin-b64' : 'stdin', chunk }); return true; } catch { return false; }
      },
    },
    stdout: child.stdout!, stderr: child.stderr!,
    get pid() { return child.pid; },
    get killed() { return killed; },
    readStartupState: () => ({ messageCount, readySeen: ready, adapterReady: ready }),
    onStartupObservation(listener) { if (observation) { try { listener(observation); } catch { /* diagnostics only */ } } observers.add(listener); },
    onControl(listener) { controls.add(listener); },
    sendControl(message) { if (destroyed) return false; try { port.postMessage(message); return true; } catch { return false; } },
    on(event, listener) { events.on(event, listener); return adapter; },
    once(event, listener) { events.once(event, listener); return adapter; },
    kill(signal) { destroyed = true; killed = true; return child.kill(signal); },
  };
  return adapter;
}

function createWindowsNodeWorker(options: NativeNodeWorkerOptions, entryPath: string, ghostId: string, childArgs?: string[]): NodeWorkerProcess {
  const events = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
  const controls = new Set<(value: unknown) => void>(), observers = new Set<(value: NodeWorkerStartupObservation) => void>();
  const pipeName = `\\\\.\\pipe\\cindy-plugin-${randomBytes(24).toString('hex')}`;
  let child: ChildProcess | undefined, port: ParentPortLike | undefined, socket: Duplex | undefined;
  let destroyed = false, killed = false, ready = false, messageCount = 0, observation: NodeWorkerStartupObservation | undefined;
  const server = createServer(connection => {
    if (destroyed || socket) { connection.destroy(); return; }
    socket = connection; server.close();
    port = createControlPort(connection, () => adapter.kill());
    port.on('message', ({ data }) => {
      messageCount++;
      if (!ready && data && typeof data === 'object' && (data as { type?: unknown }).type === 'ready') { ready = true; events.emit('spawn'); return; }
      if (ready && childArgs === undefined) for (const listener of controls) listener(data);
    });
  });
  server.on('error', error => { destroyed = true; events.emit('error', error); child?.kill(); });
  const adapter: NodeWorkerProcess = {
    stdin: { get destroyed() { return destroyed; }, write(chunk) { if (destroyed || !port) return false; try { port.postMessage({ type: childArgs === undefined ? 'stdin' : 'stdin-b64', chunk }); return true; } catch { return false; } } },
    stdout, stderr,
    get pid() { return child?.pid; }, get killed() { return killed; },
    readStartupState: () => ({ messageCount, readySeen: ready, adapterReady: ready }),
    onStartupObservation(listener) { if (observation) listener(observation); observers.add(listener); },
    onControl(listener) { controls.add(listener); },
    sendControl(message) { if (destroyed || !port) return false; try { port.postMessage(message); return true; } catch { return false; } },
    on(event, listener) { events.on(event, listener); return adapter; }, once(event, listener) { events.once(event, listener); return adapter; },
    kill(signal) {
      if (destroyed) return false;
      destroyed = true; killed = true; server.close(); socket?.destroy();
      if (child) return child.kill(signal);
      queueMicrotask(() => events.emit('exit', null, signal ?? 'SIGTERM')); return true;
    },
  };
  server.listen(pipeName, () => {
    if (destroyed) { server.close(); return; }
    const env: NodeJS.ProcessEnv = { CINDY_GHOST_ID: ghostId, CINDY_NODE_CONTROL_PIPE: pipeName };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (process.env[key] !== undefined) env[key] = process.env[key];
    child = spawn(options.nodePath, [options.workerPath, entryPath, ...(childArgs !== undefined ? [GHOST_NODE_CHILD_MODE_FLAG, ...childArgs] : [])], { cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.pipe(stdout); child.stderr!.pipe(stderr);
    child.on('spawn', () => { observation = { stage: 'utility-process-spawned', ...(child?.pid ? { pid: child.pid } : {}) }; for (const listener of observers) { try { listener(observation); } catch { /* diagnostics only */ } } });
    child.on('error', error => { destroyed = true; server.close(); socket?.destroy(); events.emit('error', error); });
    child.on('exit', (code, signal) => { destroyed = true; killed = true; server.close(); socket?.destroy(); events.emit('exit', code, signal); });
  });
  return adapter;
}
