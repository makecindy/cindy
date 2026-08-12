// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { PluginMarketPackageReviewRequest } from '../../../../shared/pluginMarket';
import { PluginMarketPermissionReviewHost } from '../PluginMarketPermissionReviewHost';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('PluginMarketPermissionReviewHost', () => {
  let reviewListener: ((review: PluginMarketPackageReviewRequest) => void) | undefined;
  let authListener: ((state: AuthStateChangePayload) => void) | undefined;
  const resolveReview = vi.fn(async () => ({ handled: true }));

  beforeEach(() => {
    dataOwnerGenerationTesting.reset();
    setDataOwnerGeneration('owner-a', 1);
    resolveReview.mockClear();
    (window as unknown as { electronAPI: Partial<Window['electronAPI']> }).electronAPI = {
      onAuthStateChange: (listener) => {
        authListener = listener;
        return () => {
          authListener = undefined;
        };
      },
      pluginMarket: {
        onPackagePermissionReview: (
          listener: (review: PluginMarketPackageReviewRequest) => void,
        ) => {
          reviewListener = listener;
          return () => {
            reviewListener = undefined;
          };
        },
        resolvePackagePermissionReview: resolveReview,
      } as unknown as Window['electronAPI']['pluginMarket'],
    };
  });

  afterEach(() => {
    cleanup();
    dataOwnerGenerationTesting.reset();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    reviewListener = undefined;
    authListener = undefined;
  });

  it('closes a delivered private review and cancels it when the data owner changes', async () => {
    render(
      <ConfirmDialogProvider>
        <PluginMarketPermissionReviewHost />
      </ConfirmDialogProvider>,
    );

    act(() => {
      reviewListener?.({
        requestId: 'review-a',
        ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
        manifest: {
          schemaVersion: 2,
          id: 'private-plugin',
          name: 'Private Plugin',
          version: '1.0.0',
          kind: 'chip',
          entry: 'main.js',
          slots: ['tool'],
        },
        permissionDiff: null,
        isUpdate: false,
        sourceType: 'server',
      });
    });
    await screen.findByText('settings.ghosts.market.installConfirmTitle');

    act(() => {
      setDataOwnerGeneration('owner-b', 2);
      authListener?.({
        user: null,
        mode: 'signed-out',
        dataOwnerId: 'owner-b',
        ownerGeneration: 2,
        canEnterApp: false,
        isAuthenticated: false,
        isCanary: false,
        deviceId: 'device',
        hasAccountDeletionReceipt: false,
        accountDeletionRestored: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('settings.ghosts.market.installConfirmTitle')).toBeNull();
      expect(resolveReview).toHaveBeenCalledWith('review-a', false);
    });
  });

  it('never shows a review whose Main delivery owner is already stale', async () => {
    render(
      <ConfirmDialogProvider>
        <PluginMarketPermissionReviewHost />
      </ConfirmDialogProvider>,
    );
    setDataOwnerGeneration('owner-b', 2);

    act(() => {
      reviewListener?.({
        requestId: 'stale-review',
        ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
        manifest: {
          schemaVersion: 2,
          id: 'private-plugin',
          name: 'Private Plugin',
          version: '1.0.0',
          kind: 'chip',
          entry: 'main.js',
          slots: ['tool'],
        },
        permissionDiff: null,
        isUpdate: false,
        sourceType: 'server',
      });
    });

    await waitFor(() => {
      expect(resolveReview).toHaveBeenCalledWith('stale-review', false);
    });
    expect(screen.queryByText('settings.ghosts.market.installConfirmTitle')).toBeNull();
  });
});
