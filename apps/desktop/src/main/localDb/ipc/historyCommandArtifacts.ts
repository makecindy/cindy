import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { throwIpcError } from '../../utils/ipcValidate';

export interface HistoryCommand {
  id: string;
  toolName: string;
  input: { command?: string; displayCommand?: string };
}

export type HistoryCommandWorkerRequest =
  | { type: 'batch'; commands: HistoryCommand[] }
  | { type: 'chunk'; field: keyof HistoryCommand['input']; text: string }
  | { type: 'large'; id: string; toolName: string };

const BATCH_CODE_UNITS = 512 * 1024;
const BATCH_TIMEOUT_MS = 30_000;
let worker: Worker | undefined;
let queue = Promise.resolve();

function commandCodeUnits({ input }: HistoryCommand): number {
  return (input.command?.length ?? 0) + (input.displayCommand?.length ?? 0);
}

function startWorker(): Worker {
  const created = new Worker(path.join(__dirname, 'historyCommandArtifactWorker.js'));
  const forget = () => {
    if (worker === created) worker = undefined;
  };
  created.on('error', forget);
  created.on('exit', forget);
  return created;
}

async function postCommands(current: Worker, commands: HistoryCommand[], isActive: () => boolean): Promise<void> {
  const post = (request: HistoryCommandWorkerRequest) => current.postMessage(request);
  const first = commands[0];
  if (commands.length !== 1 || commandCodeUnits(first) <= BATCH_CODE_UNITS) {
    post({ type: 'batch', commands });
    return;
  }
  // A single oversized command still needs its complete text. Clone it in
  // bounded pieces and let the main loop run between sends; join on the worker.
  for (const field of ['command', 'displayCommand'] as const) {
    const text = first.input[field] ?? '';
    for (let start = 0; start < text.length; start += BATCH_CODE_UNITS) {
      if (!isActive()) return;
      post({ type: 'chunk', field, text: text.slice(start, start + BATCH_CODE_UNITS) });
      await setImmediate();
    }
  }
  if (isActive()) post({ type: 'large', id: first.id, toolName: first.toolName });
}

function requestPaths(current: Worker, commands: HistoryCommand[]): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    let active = true;
    const cleanup = () => {
      active = false;
      clearTimeout(timeout);
      current.off('message', complete);
      current.off('messageerror', fail);
      current.off('error', fail);
      current.off('exit', fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error('History command worker failed'));
    };
    const complete = (paths: string[][]) => {
      if (!Array.isArray(paths) || paths.length !== commands.length) {
        fail();
        return;
      }
      cleanup();
      resolve(paths);
    };
    const timeout = setTimeout(fail, BATCH_TIMEOUT_MS);
    current.once('message', complete);
    current.once('messageerror', fail);
    current.once('error', fail);
    current.once('exit', fail);
    void postCommands(current, commands, () => active).catch(fail);
  });
}

function queueBatch(commands: HistoryCommand[]): Promise<string[][]> {
  const task = queue.then(async () => {
    let current: Worker | undefined;
    try {
      current = worker ??= startWorker();
      current.ref();
      return await requestPaths(current, commands);
    } catch {
      if (current === worker) worker = undefined;
      await current?.terminate().catch(() => undefined);
      return throwIpcError('INTERNAL', 'History outline processing failed');
    } finally {
      current?.unref();
    }
  });
  queue = task.then(() => undefined, () => undefined);
  return task;
}

export async function inferHistoryCommandArtifacts(commands: HistoryCommand[]): Promise<string[][]> {
  const paths: string[][] = [];
  let batch: HistoryCommand[] = [];
  let size = 0;
  for (const command of commands) {
    const units = commandCodeUnits(command);
    if (batch.length && size + units > BATCH_CODE_UNITS) {
      paths.push(...await queueBatch(batch));
      batch = [];
      size = 0;
    }
    batch.push(command);
    size += units;
  }
  if (batch.length) paths.push(...await queueBatch(batch));
  return paths;
}
