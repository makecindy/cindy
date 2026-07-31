/**
 * Source boundary for the generic interaction resolver.
 *
 * Device-link intentionally reuses maker:resolve-interaction for permission,
 * ask and plan decisions. Plugin setup's primary actions and Host-owned
 * confirmations must remain local even when a remote controller guesses or
 * learned a pending request id. Plugin setup cancel only detaches the caller's
 * waiter and remains remotely available.
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

export function assertResolveInteractionOrigin(
  decision: unknown,
  desktopOnlyConfirmationPending = false,
): void {
  if (!isDeviceLinkInvoke()) return;
  const kind =
    decision && typeof decision === 'object' && !Array.isArray(decision)
      ? (decision as Record<string, unknown>).kind
      : undefined;
  if (
    desktopOnlyConfirmationPending ||
    kind === 'issue_confirm' ||
    kind === 'rename_sessions_confirm' ||
    kind === 'ghost_grant_confirm'
  ) {
    throwIpcError(
      'PERMISSION_DENIED',
      'desktop-only confirmations must be completed on the controlled Desktop',
    );
  }
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
