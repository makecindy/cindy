import { useEffect } from 'react';

import { ctx, forbid, mountPage } from '../../ui-page/harness';
import { SetupMigrationSection } from '../../../src/renderer/components/settings/SetupMigrationSection';
import { SetupMigrationDialog } from '../../../src/renderer/features/setup-migration/SetupMigrationDialog';
import { SetupMigrationWalkthroughBar } from '../../../src/renderer/features/setup-migration/SetupMigrationWalkthroughBar';
import {
  openSetupMigration,
  startSetupMigrationWalkthrough,
} from '../../../src/renderer/features/setup-migration/setupMigrationStore';

const data = ctx.data as Record<string, unknown>;
type ProgressListener = (progress: unknown) => void;
const progressListeners = new Set<ProgressListener>();

function StartWalkthrough() {
  useEffect(() => {
    startSetupMigrationWalkthrough((data.walkthroughIds as string[] | undefined) ?? []);
  }, []);
  return <SetupMigrationWalkthroughBar />;
}

function OpenDialog() {
  useEffect(() => {
    openSetupMigration((data.deviceId as string | undefined) ?? null);
  }, []);
  return null;
}

mountPage({
  host: () => ({
    platform: 'darwin',
    setupMigration: {
      sources: async () => data.sources,
      preview: async () => {
        if (data.previewError) {
          throw Object.assign(new Error(`[${data.previewError}] fixture`), { code: data.previewError });
        }
        return data.plan;
      },
      apply: async () => {
        if (data.waitForSource) {
          // The other computer is being asked: show its code and keep waiting.
          for (const listener of progressListeners) listener(data.waitForSource);
          return new Promise(() => {});
        }
        return data.applyResponse;
      },
      state: async () => data.state,
      dismiss: forbid('setupMigration.dismiss'),
      onProgress: (listener: ProgressListener) => {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
      host: { ready: () => {}, reply: () => {}, onRequest: () => () => {} },
    },
    maker: {
      plugins: { list: async () => data.tools ?? [], setEnabled: async () => ({ codexMcpRefreshed: true }) },
      createCustomMcpServer: async () => ({ ok: true }),
      createCustomProvider: async () => ({ ok: true }),
    },
    deviceLink: {
      setEnabled: async () => ({ remoteControlEnabled: true }),
      setKeepAwake: async () => ({ keepAwake: true }),
    },
  }),
  render: () =>
    data.surface === 'settings' ? (
      <div className="mx-auto max-w-[720px] p-6">
        <SetupMigrationSection />
      </div>
    ) : data.surface === 'walkthrough' ? (
      <StartWalkthrough />
    ) : (
      <>
        <OpenDialog />
        <SetupMigrationDialog />
      </>
    ),
});
