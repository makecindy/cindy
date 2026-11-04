import { describe, expect, it } from 'vitest';

import { orcaModelDiscoveryFailure, throwOrcaServiceFailure } from '../orcaServiceFailure';

describe('Orca model discovery failure mapping', () => {
  // PR #6787, unit: the production host response mapper must keep discovery
  // failures actionable for list_available_models. Existing tests covered only
  // creation/IPC throwing; an online work computer disconnecting during its
  // model read or a not-yet-ready host instead became INTERNAL.
  it.each([
    ['DEVICE_OFFLINE', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['INVOKE_TIMEOUT', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['DEVICE_UNRESPONSIVE', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['LINK_NOT_OPEN', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['NOT_CONNECTED', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['PEER_RESET', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['BACKPRESSURE', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ['HOST_NOT_READY', 'HOST_NOT_READY'],
    ['UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_CAPABILITY'],
    ['REMOTE_AGENT_SHARE_PAUSED', 'REMOTE_AGENT_SHARE_PAUSED'],
    ['ACCESS_REVOKED', 'INTERNAL'],
    ['INVALID_PARAMS', 'INTERNAL'],
  ])('maps execution-device discovery %s to %s', (code, expected) => {
    const message = `[${code}] model discovery failed`;
    expect(orcaModelDiscoveryFailure(new Error(message), true))
      .toEqual({ ok: false, errorCode: expected, message });
  });

  it('keeps local and unclassified discovery failures internal', () => {
    expect(orcaModelDiscoveryFailure(new Error('[DEVICE_OFFLINE] local read failed'), false))
      .toEqual({ ok: false, errorCode: 'INTERNAL', message: '[DEVICE_OFFLINE] local read failed' });
    expect(orcaModelDiscoveryFailure('model read failed', true))
      .toEqual({ ok: false, errorCode: 'INTERNAL', message: 'model read failed' });
  });
});

describe('orca service failure IPC mapping', () => {
  it('maps Orca BUSY failures to SESSION_RUNNING instead of INTERNAL', () => {
    expect(() =>
      throwOrcaServiceFailure({
        ok: false,
        errorCode: 'BUSY',
        message: 'credential mode busy',
      }),
    ).toThrow(expect.objectContaining({ code: 'SESSION_RUNNING' }));
  });

  it('preserves provider route failures as a distinct IPC error code', () => {
    expect(() =>
      throwOrcaServiceFailure({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: 'provider route unavailable',
      }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_ROUTE_UNAVAILABLE' }));
  });
});
