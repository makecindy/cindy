import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  executionDeviceErrorMessage,
  getCollaborationStartErrorMessage,
} from '../collaborationErrors';

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

describe('executionDeviceErrorMessage', () => {
  it('explains why a Worker could not be created on another computer', () => {
    expect(
      executionDeviceErrorMessage(new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] x'), t, 'Mac mini', false),
    ).toBe('orca.createWorker.errors.deviceUnreachable');
    expect(
      executionDeviceErrorMessage(new Error('[UNSUPPORTED_CAPABILITY] x'), t, 'Mac mini', false),
    ).toBe('orca.createWorker.errors.deviceOutdated');
    expect(
      executionDeviceErrorMessage(new Error('[INVALID_PARAMS] x'), t, 'Mac mini', true),
    ).toBe('orca.createWorker.errors.dirRejected');
  });

  it('falls back to the generic collaboration message for anything else', () => {
    expect(executionDeviceErrorMessage(new Error('[INVALID_PARAMS] x'), t, 'Mac mini', false)).toBeNull();
    expect(executionDeviceErrorMessage(new Error('[INTERNAL] x'), t, undefined, true)).toBeNull();
  });

  it.each(['REMOTE_WORKDIR_NOT_FOUND', 'REMOTE_WORKDIR_NOT_DIRECTORY', 'REMOTE_WORKDIR_INVALID', 'REMOTE_WORKDIR_UNAVAILABLE'])(
    'shows an actionable directory error for %s instead of generic startup failure', (code) => {
      expect(executionDeviceErrorMessage(new Error(`[${code}] unavailable`), t, 'Mac mini', true))
        .toBe(code === 'REMOTE_WORKDIR_UNAVAILABLE' ? 'orca.createWorker.errors.dirUnavailable' : 'orca.createWorker.errors.dirRejected');
    },
  );
});
