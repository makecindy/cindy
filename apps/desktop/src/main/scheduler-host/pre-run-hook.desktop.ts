import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { utilityProcess } from 'electron';
import { adaptPluginNodeProcess, pluginNodeEnvironment } from '../cindy-brain/nodeRuntimeProcessAdapter.js';
import { GHOST_NODE_CHILD_MODE_FLAG } from '../../shared/ghost.js';
import { configurePreRunNodeScriptSpawner } from './pre-run-hook.js';

/** Reuse the shipped utilityProcess bootstrap in raw child mode: no plugin APIs or broker
 * authorization are exposed. RunAsNode stays disabled. stdin remains a normal byte stream. */
configurePreRunNodeScriptSpawner((script, cwd) => {
  const child = utilityProcess.fork(path.join(__dirname, 'nodeRuntimeWorkerProcess.desktop.js'),
    [script, GHOST_NODE_CHILD_MODE_FLAG], { cwd, env: pluginNodeEnvironment('schedule-hook'),
      stdio: ['ignore', 'pipe', 'pipe'], serviceName: 'cindy-schedule-hook' });
  const worker = adaptPluginNodeProcess(child, true);
  const events = new EventEmitter();
  let ready = false;
  const waiting: Array<() => void> = [];
  const whenReady = (fn: () => void) => { if (ready) fn(); else waiting.push(fn); };
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      whenReady(() => {
        try { worker.stdin.write(chunk.toString('base64')); callback(); }
        catch (error) { callback(error as Error); }
      });
    },
    final(callback) {
      whenReady(() => { worker.sendControl?.({ type: 'stdin-end' }); callback(); });
    },
  });
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  let exited = false;
  let streams = 2;
  const close = () => { if (exited && streams === 0) events.emit('close', exitCode, signalCode); };
  for (const stream of [worker.stdout, worker.stderr]) {
    (stream as NodeJS.ReadableStream).once('end', () => { streams--; close(); });
  }
  worker.once('spawn', () => { ready = true; for (const fn of waiting.splice(0)) fn(); });
  worker.on('error', error => { stdin.destroy(error); events.emit('error', error); });
  worker.on('exit', (code, signal) => {
    exitCode = code; signalCode = signal; exited = true;
    events.emit('exit', code, signal); close();
  });
  Object.defineProperties(events, {
    pid: { get: () => worker.pid }, exitCode: { get: () => exitCode }, signalCode: { get: () => signalCode },
    killed: { get: () => worker.killed },
  });
  return Object.assign(events, { stdin, stdout: worker.stdout, stderr: worker.stderr,
    kill: (signal?: NodeJS.Signals) => worker.kill(signal) }) as unknown as ChildProcess;
});
