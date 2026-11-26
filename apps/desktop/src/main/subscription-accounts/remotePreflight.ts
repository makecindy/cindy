import { AsyncLocalStorage } from 'node:async_hooks';
import type { RemoteSubscriptionInvoke } from './runtime.js';

export class RemoteAccountReadUnavailable extends Error {
  constructor(readonly deviceId: string, cause: Error) {
    super(cause.message, { cause });
  }
}

type AccountRead = ReturnType<RemoteSubscriptionInvoke>;
const sendReads = new AsyncLocalStorage<WeakMap<object, Map<string, AccountRead>>>();

export function withRemoteAccountReads<Result>(prepare: () => Promise<Result>): Promise<Result> {
  return sendReads.run(new WeakMap(), prepare);
}

export function readAccountBeforeSend(invoke: RemoteSubscriptionInvoke, owner: object): RemoteSubscriptionInvoke {
  return async (deviceId, channel, args, options) => {
    options.preSend();
    const scope = sendReads.getStore();
    if (!scope) return invoke(deviceId, channel, args, options);
    let reads = scope.get(owner);
    if (!reads) scope.set(owner, reads = new Map());
    try {
      const key = JSON.stringify([deviceId, channel, args]);
      const read = reads.get(key) ?? invoke(deviceId, channel, args, options);
      reads.set(key, read);
      const reply = await read;
      options.preSend();
      return reply;
    } catch (error) {
      options.preSend();
      if (error instanceof Error && 'code' in error &&
        ['DEVICE_OFFLINE', 'INVOKE_TIMEOUT', 'PEER_RESET', 'DEVICE_UNRESPONSIVE', 'NOT_CONNECTED'].includes(String(error.code))) {
        throw new RemoteAccountReadUnavailable(deviceId, error);
      }
      throw error;
    }
  };
}
