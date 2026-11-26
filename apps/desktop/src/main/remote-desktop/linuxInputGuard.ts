import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LinuxInputText } from './linuxX11Input';

const exec = promisify(execFile);

export async function linuxGuardPath(): Promise<string> {
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'remote-desktop', 'linux-input-guard.py')
    : path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-input-guard.py');
  await access('/usr/bin/python3', constants.X_OK);
  await access(helper, constants.R_OK);
  return helper;
}

export async function openLinuxInputGuard(environment: NodeJS.ProcessEnv, onFailure: () => void) {
  const helper = await linuxGuardPath();
  const child = spawn('/usr/bin/python3', ['-I', helper], { env: environment, stdio: 'pipe' });
  child.stderr.resume();
  let closing = false;
  let stopping: Promise<void> | undefined;
  let sequence = 0;
  let output = '';
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let pending:
    | {
        id: number;
        finish(error?: Error, value?: string): void;
      }
    | undefined;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const close = (): Promise<void> => {
    if (stopping) return stopping;
    closing = true;
    rejectReady(new Error('DESKTOP_INPUT_UNAVAILABLE'));
    pending?.finish(new Error('DESKTOP_INPUT_UNAVAILABLE'));
    child.stdin.end();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    stopping = closed.finally(() => clearTimeout(timer));
    return stopping;
  };
  const fail = () => {
    if (closing) return;
    void close();
    onFailure();
  };
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('exit', fail);
  child.stdout.on('data', (data: Buffer) => {
    if (closing) return;
    output += data.toString();
    if (output.length > 4096) {
      fail();
      return;
    }
    while (output.includes('\n')) {
      const end = output.indexOf('\n');
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (!ready) {
        if (line !== 'ready') {
          fail();
          return;
        }
        ready = true;
        resolveReady();
      } else {
        try {
          const response = JSON.parse(line);
          if (!pending || response.id !== pending.id || typeof response.stdout !== 'string')
            throw new Error('DESKTOP_INPUT_UNAVAILABLE');
          pending.finish(undefined, response.stdout);
        } catch {
          fail();
          return;
        }
      }
    }
  });
  const startupTimer = setTimeout(fail, 2000);
  try {
    await started;
  } catch {
    await close();
    throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  } finally {
    clearTimeout(startupTimer);
  }
  const write = (value: unknown) => {
    const line = `${JSON.stringify(value)}\n`;
    if (
      closing ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.stdin.destroyed ||
      child.stdin.writableLength + Buffer.byteLength(line) > 32_768
    )
      throw new Error('DESKTOP_INPUT_UNAVAILABLE');
    child.stdin.write(line);
  };
  const request = (body: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error('DESKTOP_INPUT_BUSY'));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('DESKTOP_LEASE_EXPIRED'));
        return;
      }
      const id = ++sequence;
      const abort = () => {
        pending?.finish(new Error('DESKTOP_LEASE_EXPIRED'));
        void close();
      };
      const timer = setTimeout(fail, 1500);
      pending = {
        id,
        finish(error, value) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          pending = undefined;
          if (error) reject(error);
          else resolve(value ?? '');
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        write({ id, ...body });
      } catch {
        pending?.finish(new Error('DESKTOP_INPUT_UNAVAILABLE'));
        fail();
      }
    });
  };
  return {
    command: (args: string[], signal?: AbortSignal) => request({ args }, signal),
    async insertText(input: LinuxInputText): Promise<void> {
      // Split by code point, not UTF-16 unit. Each bounded native chunk rechecks
      // the lease/display; the helper checks the original X11 focus per character.
      const characters = Array.from(input.text);
      for (let offset = 0; offset < characters.length; offset += 32) {
        await input.validate();
        await request(
          {
            text: {
              windowId: input.windowId,
              pid: input.pid,
              text: characters.slice(offset, offset + 32).join(''),
            },
          },
          input.signal,
        );
      }
      await input.validate();
    },
    hold(keys: string[], buttons: number[]) {
      write({ keys, buttons });
    },
    close,
  };
}

export async function checkLinuxInputGuard(environment: NodeJS.ProcessEnv): Promise<void> {
  try {
    const helper = await linuxGuardPath();
    const { stdout } = await exec('/usr/bin/python3', ['-I', helper, '--check'], {
      env: environment,
      timeout: 1500,
      maxBuffer: 256,
    });
    if (stdout !== 'ready\n') throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  } catch {
    throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  }
}
