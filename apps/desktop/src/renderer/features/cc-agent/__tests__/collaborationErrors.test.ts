import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { getCollaborationStartErrorMessage } from '../collaborationErrors';

const t = ((key: string) => key) as unknown as TFunction;

describe('getCollaborationStartErrorMessage', () => {
  it.each([
    'INVALID_PARAMS',
    'PRECONDITION_FAILED',
    'NO_PROVIDER_FOR_AGENT',
    'PROVIDER_ROUTE_UNAVAILABLE',
    'BUDGET_MODEL_REQUIRES_API_MODE',
  ])(
    'maps %s to a controlled-device action when the Lead is remote',
    (code) => {
      expect(
        getCollaborationStartErrorMessage(new Error(`[${code}] rejected`), t, {
          remoteDevice: true,
        }),
      ).toBe(`newChat.collaboration.errors.${code}_REMOTE`);
    },
  );

  it('keeps the continue-as-single-session suffix for local draft failures', () => {
    expect(
      getCollaborationStartErrorMessage(new Error('[NO_PROVIDER_FOR_AGENT] unavailable'), t, {
        continueAsSingleSession: true,
      }),
    ).toBe('newChat.collaboration.errors.NO_PROVIDER_FOR_AGENT_CONTINUE');
  });

  it('falls back to the generic collaboration error for unknown failures', () => {
    expect(getCollaborationStartErrorMessage(new Error('boom'), t)).toBe(
      'newChat.collaboration.startFailed',
    );
  });

  it('maps a device-link capability mismatch to the upgrade hint', () => {
    expect(
      getCollaborationStartErrorMessage(
        new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] capability missing'),
        t,
        { remoteDevice: true },
      ),
    ).toBe('newChat.collaboration.unsupportedRemoteHint');
  });
});
