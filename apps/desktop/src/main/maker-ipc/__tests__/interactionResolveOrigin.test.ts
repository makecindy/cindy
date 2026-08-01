import { describe, expect, it } from 'vitest';

import {
  isDeviceLinkInvoke,
  runDeviceLinkInvokeContext,
} from '../../device-link/invoke-context.js';
import { assertResolveInteractionOrigin } from '../interactionResolveOrigin.js';

function fromDeviceLink(decision: unknown, desktopOnlyConfirmationPending = false): void {
  runDeviceLinkInvokeContext(
    { controllerDeviceId: 'controller-1', channel: 'maker:resolve-interaction' },
    () => assertResolveInteractionOrigin(decision, desktopOnlyConfirmationPending),
  );
}

describe('resolve interaction source boundary', () => {
  it.each([
    { kind: 'permission', behavior: 'allow' },
    { kind: 'ask_user_question', answers: { provider: 'brave' } },
    { kind: 'plan_review', behavior: 'allow' },
    { kind: 'plugin_setup', action: 'cancel' },
  ])('keeps remote $kind decisions available', (decision) => {
    expect(() => fromDeviceLink(decision)).not.toThrow();
  });

  it.each([
    { kind: 'plugin_setup', action: 'run_action', actionId: 'oauth:account' },
    { kind: 'plugin_setup' },
  ])('rejects remote plugin setup before command parsing', (decision) => {
    expect(() => fromDeviceLink(decision)).toThrow(
      '[PERMISSION_DENIED] plugin setup actions must be completed on the controlled Desktop',
    );
  });

  it.each([
    { kind: 'issue_confirm', confirmed: true },
    { kind: 'rename_sessions_confirm', confirmed: true },
    { kind: 'ghost_grant_confirm', confirmed: true },
  ])('rejects remote Desktop-only $kind decisions', (decision) => {
    expect(() => fromDeviceLink(decision)).toThrow(
      '[PERMISSION_DENIED] desktop-only confirmations must be completed on the controlled Desktop',
    );
  });

  it('rejects a remote decision by pending request ownership even when its payload has no kind', () => {
    expect(() => fromDeviceLink({ confirmed: true }, true)).toThrow(
      '[PERMISSION_DENIED] desktop-only confirmations must be completed on the controlled Desktop',
    );
  });

  it.each([
    { kind: 'plugin_setup', action: 'run_action', actionId: 'oauth:account' },
    { kind: 'issue_confirm', confirmed: true },
    { kind: 'rename_sessions_confirm', confirmed: true },
    { kind: 'ghost_grant_confirm', confirmed: true },
  ])('keeps the same $kind decision available to the trusted local Renderer', (decision) => {
    expect(isDeviceLinkInvoke()).toBe(false);
    expect(() => assertResolveInteractionOrigin(decision)).not.toThrow();
  });
});
