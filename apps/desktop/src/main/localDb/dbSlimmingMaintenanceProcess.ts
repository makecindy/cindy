import fs from 'node:fs';

import { runDbSlimmingMaintenance } from './dbSlimmingMaintenance';
import type {
  DbSlimmingProcessCommand,
  DbSlimmingProcessInput,
  DbSlimmingProcessMessage,
} from './dbSlimmingProcessProtocol';

interface ParentPortLike {
  postMessage(message: DbSlimmingProcessMessage): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const processPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!processPort) throw new Error('database cleanup process requires an Electron parent port');

let started = false;
let releaseCommit: (() => void) | null = null;

function post(message: DbSlimmingProcessMessage): void {
  processPort!.postMessage(message);
}

function postLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  try {
    post({ type: 'log', level, message, meta });
  } catch {
    post({ type: 'log', level, message });
  }
}

async function run(input: DbSlimmingProcessInput): Promise<void> {
  await runDbSlimmingMaintenance({
    ...input,
    loadVectorExtension: (db) => {
      if (!input.sqliteVecExtensionPath || !fs.existsSync(input.sqliteVecExtensionPath)) {
        return false;
      }
      try {
        db.loadExtension(input.sqliteVecExtensionPath);
        return true;
      } catch (error) {
        postLog('warn', 'database cleanup process could not load sqlite-vec', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    onProgress: (progress) => post({ type: 'progress', progress }),
    beforeReplacement: () =>
      new Promise<void>((resolve) => {
        releaseCommit = resolve;
        post({ type: 'commit-ready' });
      }),
    log: {
      info: (message, meta) => postLog('info', message, meta),
      warn: (message, meta) => postLog('warn', message, meta),
      error: (message, meta) => postLog('error', message, meta),
    },
  }).then(
    (outcome) => post({ type: 'result', outcome }),
    (error) =>
      post({
        type: 'error',
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      }),
  );
}

processPort.on('message', (event) => {
  const command = event.data as Partial<DbSlimmingProcessCommand> | undefined;
  if (command?.type === 'commit') {
    const resolve = releaseCommit;
    releaseCommit = null;
    resolve?.();
    return;
  }
  if (command?.type !== 'start' || started || !command.input) return;
  started = true;
  void run(command.input);
});

post({ type: 'ready' });
