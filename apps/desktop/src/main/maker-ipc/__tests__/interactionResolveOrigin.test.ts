import { describe, expect, it } from 'vitest';

import {
  isDeviceLinkInvoke,
  runDeviceLinkInvokeContext,
} from '../../device-link/invoke-context.js';
import { assertResolveInteractionOrigin } from '../interactionResolveOrigin.js';

function fromDeviceLink(decision: unknown): void {
  runDeviceLinkInvokeContext(
    { controllerDeviceId: 'controller-1', channel: 'maker:resolve-interaction' },
    () => assertResolveInteractionOrigin(decision),
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

  it('keeps the same plugin setup decisions available to the trusted local Renderer', () => {
    expect(isDeviceLinkInvoke()).toBe(false);
    expect(() =>
      assertResolveInteractionOrigin({
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'oauth:account',
      }),
    ).not.toThrow();
  });
});
