import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** Window trust belongs to IPC ingress, not the model transaction also used by Bots. */
export function registerSessionSetModelHandler(
  registry: IpcHandlerRegistry,
  deps: {
    isDeviceLinkInvoke(): boolean;
    assertTrustedSender(event: unknown): void;
    apply(sessionId: unknown, model: unknown, providerId: unknown, revision: unknown, selection: unknown): unknown;
  },
): void {
  registry.handle(MAKER_INVOKE.SET_MODEL, (event, sessionId, model, providerId, revision, selection) => {
    // Remote callers have already passed device-link authentication and control checks.
    if (!deps.isDeviceLinkInvoke()) deps.assertTrustedSender(event);
    return deps.apply(sessionId, model, providerId, revision, selection);
  });
}
