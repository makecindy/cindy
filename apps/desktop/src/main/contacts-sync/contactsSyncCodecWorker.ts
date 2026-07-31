// eslint-disable-next-line no-restricted-imports -- bounded contacts codec work is isolated from Main.
import { parentPort } from 'node:worker_threads';

import {
  decodeContactsSyncMessageInProcess,
  encodeContactsSyncMessageInProcess,
  type ContactsSyncCodecWorkerRequest,
  type ContactsSyncCodecWorkerResponse,
} from './contactsSyncCodec.js';

const port = parentPort;
if (!port) throw new Error('contacts sync codec must run in a worker thread');

port.once('message', (request: ContactsSyncCodecWorkerRequest) => {
  let response: ContactsSyncCodecWorkerResponse;
  try {
    const data =
      request.type === 'encode'
        ? encodeContactsSyncMessageInProcess(request.options)
        : decodeContactsSyncMessageInProcess(request.options);
    response = { id: request.id, ok: true, data };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'contacts sync codec failed',
    };
  }
  port.postMessage(response);
});
