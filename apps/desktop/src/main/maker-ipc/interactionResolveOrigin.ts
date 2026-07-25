/**
 * Source boundary for the generic interaction resolver.
 *
 * Device-link intentionally reuses maker:resolve-interaction for permission,
 * ask and plan decisions. Plugin setup's primary actions open OAuth or trusted
 * local Settings on the controlled Desktop, so they must remain local even
 * when a remote controller knows the pending request/action ids. Cancel only
 * detaches the caller's waiter and remains remotely available.
 */

import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export function isPluginSetupInteractionDecision(
  decision: unknown,
): decision is Record<string, unknown> & { kind: 'plugin_setup' } {
  return (
    !!decision &&
    typeof decision === 'object' &&
    !Array.isArray(decision) &&
    (decision as Record<string, unknown>).kind === 'plugin_setup'
  );
}

export function assertResolveInteractionOrigin(decision: unknown): void {
  if (!isDeviceLinkInvoke()) return;
  if (
    isPluginSetupInteractionDecision(decision) &&
    (decision as Record<string, unknown>).action !== 'cancel'
  ) {
    throwIpcError(
      'PERMISSION_DENIED',
      'plugin setup actions must be completed on the controlled Desktop',
    );
  }
}
