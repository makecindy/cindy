import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { createElement } from 'react';
import {
  PluginModelPickerDialog,
  PluginModelPickerPopover,
} from '../../../src/renderer/cindy-brain/PluginModelPickerHost';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
} from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';

const provider = {
  id: 'example',
  name: 'Example Provider',
  source: 'user',
  auth: { method: 'none' },
  connected: true,
  agents: ['codex'],
  routing: { codex: {} },
  models: {
    codex: [
      {
        id: 'demo',
        name: 'Demo Model',
        mode: 'chat',
        contextWindow: 128000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsFastMode: true,
      },
    ],
  },
} as unknown as ProviderView;
const owner = getDataOwnerGeneration();
const snapshot = {
  dataOwnerId: owner.dataOwnerId,
  ownerGeneration: owner.generation,
  providers: [provider],
  providerOrder: [provider.id],
};
commitProvidersSnapshot(beginProvidersRefresh(), snapshot);

void mountPage({
  host: {
    safeStorageRead: async () => null,
    deviceLink: {
      listDevices: async () => [],
      getState: async () => ({ remoteControlEnabled: false, linkStatus: 'stopped' }),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('linkStatus'),
      onControlTargetChanged: subscription('controlTargets'),
      onRemotePush: subscription('remotePush'),
    },
    maker: {
      listProviders: async () => snapshot,
      requestProviderModelsAutoRefresh: async () => undefined,
      listAvailableAgents: async () => ['codex'],
      onProvidersChanged: subscription('providersChanged'),
      getModelContextLimit: async () => ({ limit: 128000, isCustomized: false }),
      getCapabilities: async () => ({
        hasFastMode: true,
        availableModels: [],
        effortLevels: ['low', 'medium', 'high'].map((id) => ({ id, displayName: id })),
        permissionModes: [],
      }),
      setModel: forbid('maker.setModel'),
      createSession: forbid('maker.createSession'),
    },
  },
  render: (ctx) =>
    ctx.case.startsWith('page-popover') ? (
      <>
        {/* Geometry fixture only: no native guest transport is simulated as tested here. */}
        {createElement('webview', {
          ref: (element: HTMLElement | null) => {
            if (element) Object.assign(element, { getWebContentsId: () => 42 });
          },
          style: { position: 'fixed', inset: 0, display: 'block', width: '100%', height: '100%' },
        })}
        <PluginModelPickerPopover
          request={{
            requestId: 'page-fixture',
            ghostId: 'example-plugin',
            ghostName: 'Example Plugin',
            expiresAt: Date.now() + 90_000,
            pageAnchor: {
              guestId: 42,
              rect: {
                x: 24,
                y: ctx.case === 'page-popover-bottom' ? 660 : 48,
                width: 160,
                height: 36,
              },
            },
            initial: {
              agentKind: 'codex',
              providerId: 'example',
              model: 'demo',
              effort: 'medium',
              fastMode: false,
            },
          }}
          onAnswer={async () => ({ handled: true, accepted: false })}
        />
      </>
    ) : (
      <PluginModelPickerDialog
        request={{
          requestId: 'fixture',
          ghostId: 'example-plugin',
          ghostName: 'Example Plugin',
          expiresAt: Date.now() + 90_000,
          initial: {
            agentKind: 'codex',
            providerId: 'example',
            model: 'demo',
            effort: 'medium',
            fastMode: false,
          },
        }}
        onAnswer={async () => ({ handled: true, accepted: false })}
      />
    ),
});
