import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '../contexts/dataOwnerGeneration';
import { __testing as remoteDataOwnerPushFenceTesting } from '../lib/remoteDataOwnerPushFence';

const mocks = vi.hoisted(() => ({
  translate: vi.fn((key: string) => key),
  warning: vi.fn(),
}));

vi.mock('@/i18n', () => ({ i18n: { t: mocks.translate } }));
vi.mock('../lib/toast', () => ({ toast: { warning: mocks.warning } }));

import {
  handleAutoPermissionFallback,
  installAutoPermissionFallbackToastListener,
  type AutoPermissionFallbackPayload,
} from '../lib/autoPermissionFallbackToast';

const payload: AutoPermissionFallbackPayload = {
  sessionId: 'session-1',
  from: 'auto',
  to: 'ask',
  reason: 'classifier_unavailable',
  status: 429,
};

beforeEach(() => {
  mocks.translate.mockClear();
  mocks.warning.mockClear();
  dataOwnerGenerationTesting.reset();
  remoteDataOwnerPushFenceTesting.reset();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  remoteDataOwnerPushFenceTesting.reset();
  dataOwnerGenerationTesting.reset();
  vi.unstubAllGlobals();
});

describe('autoPermissionFallbackToast', () => {
  it('shows the localized warning text', () => {
    handleAutoPermissionFallback();

    expect(mocks.translate).toHaveBeenCalledWith('newChat.permissionSelector.autoFallback');
    expect(mocks.warning).toHaveBeenCalledWith('newChat.permissionSelector.autoFallback');
  });

  it('subscribes to local and device-link fallback pushes and cleans both up', () => {
    let localListener: ((event: AutoPermissionFallbackPayload) => void) | undefined;
    let remoteListener:
      ((push: { deviceId: string; channel: string; payload: unknown }) => void) | undefined;
    const offLocal = vi.fn();
    const offRemote = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          onAutoPermissionFallback: vi.fn((listener) => {
            localListener = listener;
            return offLocal;
          }),
        },
        deviceLink: {
          onRemotePush: vi.fn((listener) => {
            remoteListener = listener;
            return offRemote;
          }),
        },
      },
    });

    const dispose = installAutoPermissionFallbackToastListener();
    localListener?.(payload);
    remoteListener?.({
      deviceId: 'device-1',
      channel: 'maker:auto-permission:fallback',
      payload,
    });
    remoteListener?.({
      deviceId: 'device-1',
      channel: 'maker:auto-permission:fallback',
      payload: { ...payload, to: 'bypassPermissions' },
    });

    expect(mocks.warning).toHaveBeenCalledTimes(2);
    dispose();
    expect(offLocal).toHaveBeenCalledTimes(1);
    expect(offRemote).toHaveBeenCalledTimes(1);
  });
});
