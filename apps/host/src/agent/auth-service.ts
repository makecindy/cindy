import { EventEmitter } from 'node:events';
import type { Maker } from '@cindy/maker-core';
import { registerMakerAuthHandlers, type AuthLoginController } from '../../../desktop/src/main/maker-ipc/authHandlers.js';
import type { IpcHandler } from '../../../desktop/src/main/maker-ipc/ipcHandlerRegistry.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';

/** Shared login arbitration. Controller identities come from the authenticated
 * transport, never a request body or a fabricated renderer window. */
export function createHostAgentAuth(options: {
  maker: Maker; readApiKey(): string | null; publish(channel: string, payload: unknown): void;
}) {
  const owner = activeOwnerScopeKey();
  let closed = false;
  const controllers = new Map<string, AuthLoginController & EventEmitter>();
  const handlers = new Map<string, IpcHandler>();
  const check = () => {
    if (closed || owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('AUTH_OWNER_CHANGED');
  };
  registerMakerAuthHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, options.maker,
    (channel, payload) => { if (!closed && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending()) options.publish(channel, payload); },
    options.readApiKey, undefined,
    event => typeof event === 'string' ? controllers.get(event) ?? null : null);
  return {
    async invoke(channel: string, args: unknown[], caller: string) {
      check();
      if (!caller) throw new Error('Authenticated login controller is required');
      const handler = handlers.get(channel);
      if (!handler) throw new Error('Unknown authentication operation');
      if (!controllers.has(caller)) controllers.set(caller, Object.assign(new EventEmitter(), { id: caller }));
      const result = await handler(caller, ...args); check(); return result;
    },
    releaseCaller(caller: string) {
      const controller = controllers.get(caller); controllers.delete(caller); controller?.emit('destroyed');
    },
    close() {
      closed = true;
      for (const controller of controllers.values()) controller.emit('destroyed');
      controllers.clear();
    },
  };
}
