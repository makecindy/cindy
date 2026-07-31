// eslint-disable-next-line no-restricted-imports -- bounded contacts codec work is isolated from Main.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import {
  createContactsSyncDelta,
  MakerContactsStore,
  type ContactsSyncState,
} from '@cindy/maker-core/contacts-sync-worker';

import {
  decodeContactsSyncMessageInProcess,
  encodeContactsSyncJsonInProcess,
  type ContactsSyncDatabaseSource,
  type ContactsSyncEncodedPayload,
  type ContactsSyncCodecWorkerRequest,
  type ContactsSyncCodecWorkerResponse,
} from './contactsSyncCodec.js';

const port = parentPort;
if (!port) throw new Error('contacts sync codec must run in a worker thread');

port.once('message', (request: ContactsSyncCodecWorkerRequest) => {
  let response: ContactsSyncCodecWorkerResponse;
  let transferList: ArrayBuffer[] = [];
  try {
    const data =
      request.type === 'encode'
        ? encodeRequest(request)
        : request.type === 'decode'
          ? decodeRequest(request)
          : prepareRequest(request);
    if (isEncodedPayload(data)) transferList = [data.ciphertext.buffer];
    response = { id: request.id, ok: true, data };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'contacts sync codec failed',
    };
  }
  port.postMessage(response, transferList);
});

function prepareRequest(
  request: Extract<ContactsSyncCodecWorkerRequest, { type: 'prepare' }>,
): { materialized: boolean } {
  throwIfCancelled(request);
  return withContactsStore(
    request.source,
    (store) => {
      throwIfCancelled(request);
      const result = store.prepareDeviceSyncStateForTransfer();
      return { materialized: result.materialized };
    },
    true,
  );
}

function encodeRequest(
  request: Extract<ContactsSyncCodecWorkerRequest, { type: 'encode' }>,
): ContactsSyncEncodedPayload {
  throwIfCancelled(request);
  const options = request.options;
  if (options.message) {
    return encodeContactsSyncJsonInProcess(
      Buffer.from(JSON.stringify(options.message), 'utf8'),
      options,
    );
  }

  return withContactsStore(options.database.source, (store) => {
    throwIfCancelled(request);
    const result = store.prepareDeviceSyncStateForTransfer();
    const state = options.database.knownClocks
      ? createContactsSyncDelta(result.state, options.database.knownClocks)
      : result.state;
    throwIfCancelled(request);
    const message = {
      version: 1 as const,
      type: 'state' as const,
      state,
      ...(options.database.requestReply ? { requestReply: true } : {}),
    };
    return encodeContactsSyncJsonInProcess(
      Buffer.from(JSON.stringify(message), 'utf8'),
      options,
      result.materialized,
    );
  });
}

function decodeRequest(
  request: Extract<ContactsSyncCodecWorkerRequest, { type: 'decode' }>,
): unknown {
  throwIfCancelled(request);
  const message = decodeContactsSyncMessageInProcess(request.options);
  const source = request.options.databaseSource;
  if (!source) return message;

  return withContactsStore(source, (store) => {
    throwIfCancelled(request);
    const changed = store.mergeDeviceSyncStateForTransfer(message.state);
    const state = message.state as ContactsSyncState;
    return {
      version: 1 as const,
      type: 'applied-state' as const,
      changed,
      clocks: state.clocks.map((clock) => ({ ...clock })),
      ...(message.requestReply ? { requestReply: true } : {}),
    };
  });
}

function withContactsStore<T>(
  source: ContactsSyncDatabaseSource,
  task: (store: MakerContactsStore) => T,
  runStartupMaintenance = false,
): T {
  assertDatabaseSource(source);
  const workerRequire = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url,
  );
  const loaded = workerRequire(source.betterSqliteModulePath ?? 'better-sqlite3') as
    | typeof import('better-sqlite3')
    | { default: typeof import('better-sqlite3') };
  const DatabaseConstructor = 'default' in loaded ? loaded.default : loaded;
  const options: Database.Options = source.nativeBinding
    ? { nativeBinding: source.nativeBinding }
    : {};
  const db = new DatabaseConstructor(source.dbPath, options);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const store = new MakerContactsStore({
      db,
      logger: NOOP_LOGGER,
      skipStartupMaintenance: !runStartupMaintenance,
    });
    store.init();
    return task(store);
  } finally {
    db.close();
  }
}

const NOOP_LOGGER = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return NOOP_LOGGER;
  },
};

function assertDatabaseSource(source: ContactsSyncDatabaseSource): void {
  if (
    !source ||
    typeof source.dbPath !== 'string' ||
    source.dbPath.length === 0 ||
    source.dbPath.length > 4096 ||
    (source.betterSqliteModulePath !== undefined &&
      (typeof source.betterSqliteModulePath !== 'string' ||
        source.betterSqliteModulePath.length > 4096)) ||
    (source.nativeBinding !== undefined &&
      (typeof source.nativeBinding !== 'string' || source.nativeBinding.length > 4096))
  ) {
    throw new Error('invalid contacts sync database source');
  }
}

function isEncodedPayload(value: unknown): value is ContactsSyncEncodedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ciphertext' in value &&
    value.ciphertext instanceof Uint8Array
  );
}

function throwIfCancelled(request: ContactsSyncCodecWorkerRequest): void {
  const buffer = request.cancellation;
  if (!buffer) return;
  if (buffer.byteLength !== 4) throw new Error('invalid contacts sync cancellation flag');
  if (Atomics.load(new Int32Array(buffer), 0) !== 0) {
    throw new Error('contacts sync codec aborted');
  }
}
