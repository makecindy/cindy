import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import {
  adaptPluginNodeProcess, pluginNodeEnvironment, type PluginNodeProcess,
} from '../../../desktop/src/main/cindy-brain/nodeRuntimeProcessAdapter.js';
import { createPluginControlPipe } from '../../../desktop/src/main/cindy-brain/nodeRuntimePipe.js';
import { GhostNodeRuntimeBroker, type GhostNodeRuntimeBrokerDeps } from '../../../desktop/src/main/cindy-brain/nodeRuntimeBroker.js';

/** The launcher supplies its prebuilt worker, not a plugin-selected program.
 * All plugin entry/receipt/owner checks remain in the common broker. */
export function createNodePluginProcessFactory(workerEntry: string) {
  return (entryPath: string, _cwd: string, ghostId: string, childArgs?: string[]) => {
    // Declared child entries are ordinary Node programs: their real stdin and
    // natural exit must not be kept alive by the worker's private control pipe.
    if (childArgs !== undefined) {
      const child = spawn(process.execPath, [entryPath, ...childArgs], {
        cwd: os.tmpdir(), env: pluginNodeEnvironment(ghostId),
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      const events = new EventEmitter();
      const native = Object.assign(events, {
        stdout: child.stdout, stderr: child.stderr,
        postMessage(message: unknown) {
          const value = message as { type?: string; chunk?: string };
          if (value.type === 'stdin-b64' && typeof value.chunk === 'string') {
            child.stdin.write(Buffer.from(value.chunk, 'base64'));
          } else if (value.type === 'stdin-end') child.stdin.end();
        },
        kill: () => child.kill(),
      }) as PluginNodeProcess;
      Object.defineProperty(native, 'pid', { get: () => child.pid });
      child.once('spawn', () => { events.emit('spawn'); events.emit('message', { type: 'ready' }); });
      child.once('error', () => events.emit('error', 'spawn-failed', 'plugin child'));
      child.once('exit', code => events.emit('exit', code));
      // A program may exit before its stdin is written; route EPIPE through the
      // broker instead of throwing an unhandled stream error in the Host.
      child.stdin.on('error', () => events.emit('error', 'stdin-closed', 'plugin child'));
      return adaptPluginNodeProcess(native, true);
    }
    const child = spawn(process.execPath, [workerEntry, entryPath], {
      cwd: os.tmpdir(), env: pluginNodeEnvironment(ghostId),
      // 'overlapped' is a plain pipe on POSIX. On Windows the worker opens this
      // inherited descriptor with net.Socket, which libuv accepts only when the
      // child's handle was created overlapped; a plain pipe never delivers `ready`.
      stdio: ['ignore', 'pipe', 'pipe', 'overlapped'], windowsHide: true,
    });
    const control = child.stdio[3] as Duplex;
    const events = new EventEmitter();
    const pipe = createPluginControlPipe(control,
      message => events.emit('message', message),
      () => { child.kill(); events.emit('error', 'control-disconnected', 'plugin worker'); });
    const native = Object.assign(events, {
      stdout: child.stdout, stderr: child.stderr,
      postMessage: pipe.send,
      kill: () => child.kill(),
    }) as PluginNodeProcess;
    Object.defineProperty(native, 'pid', { get: () => child.pid });
    child.once('spawn', () => events.emit('spawn'));
    child.once('error', () => { pipe.dispose(); events.emit('error', 'spawn-failed', 'plugin worker'); });
    child.once('exit', code => { pipe.dispose(); events.emit('exit', code); });
    return adaptPluginNodeProcess(native, childArgs !== undefined);
  };
}

export function createHostNodeRuntimeBroker(
  workerEntry: string,
  deps: Omit<GhostNodeRuntimeBrokerDeps, 'spawnProcess' | 'spawnChildProcess'>,
) {
  const spawnProcess = createNodePluginProcessFactory(workerEntry);
  return new GhostNodeRuntimeBroker({ ...deps, spawnProcess, spawnChildProcess: spawnProcess });
}
