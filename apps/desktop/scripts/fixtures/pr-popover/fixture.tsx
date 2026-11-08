import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { GitContextBadge } from '../../../src/renderer/features/cc-agent/GitContextBadge';
import { Tooltip } from '../../../src/renderer/components/ui/tooltip';
import { ingestCardPush } from '../../../src/renderer/cindy-brain/ghostCardStore';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import cards from './cards.json';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
} from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
const provider = {
  id: 'example',
  name: '示例供应商',
  source: 'user',
  auth: { method: 'none' },
  connected: true,
  agents: ['codex'],
  routing: { codex: {} },
  models: {
    codex: [
      {
        id: 'demo',
        name: '演示模型 A',
        mode: 'chat',
        contextWindow: 128000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        supportsFastMode: true,
      },
      {
        id: 'demo-b',
        name: '演示模型 B',
        mode: 'chat',
        contextWindow: 128000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
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
  providerOrder: ['example'],
};
commitProvidersSnapshot(beginProvidersRefresh(), snapshot);
let settings = false,
  following = false,
  mode = 'task';
const rows = [
  {
    id: 'ref',
    sessionId: 'pr-task',
    owner: 'makecindy',
    repo: 'cindy',
    prNumber: 9261,
    pinned: true,
    associationSource: 'manual',
    removedAt: null,
  },
  {
    id: 'ref-2',
    sessionId: 'pr-task',
    owner: 'makecindy',
    repo: 'cindy',
    prNumber: 9262,
    pinned: false,
    associationSource: 'manual',
    removedAt: null,
  },
];
let managed = rows;
const cardHtml = () =>
  cards[
    `${following ? 'on' : 'off'}-${settings ? 'settings' : 'summary'}-${mode}` as keyof typeof cards
  ];
function update() {
  ingestCardPush({
    callId: 'pr-card',
    sessionId: 'pr-task',
    ghostId: 'cindy-github',
    toolUseId: null,
    html: cardHtml(),
    height: 200,
  });
}
mountPage({
  host: () => ({
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
    },
    gitContext: {
      managePrRefs: async (op: { action: string; id?: string }) => {
        managed = managed.map((r) =>
          r.id !== op.id
            ? r
            : {
                ...r,
                ...(op.action === 'pin'
                  ? { pinned: true }
                  : op.action === 'unpin'
                    ? { pinned: false }
                    : op.action === 'remove'
                      ? { removedAt: 1 }
                      : op.action === 'restore'
                        ? { removedAt: null }
                        : {}),
              },
        );
        return managed;
      },
      getPrStatuses: async () => [],
    },
    ghosts: {
      listCardsBySession: async () => ({
        cards: [{ callId: 'pr-card', ghostId: 'cindy-github', html: cardHtml(), height: 200 }],
      }),
      onCardUpdated: subscription('card-updated'),
      listSync: () => ({
        ghosts:
          ctx.case === 'uninstalled'
            ? []
            : [
                {
                  manifest: {
                    id: 'cindy-github',
                    name: 'GitHub',
                    card: { externalLinks: ['https://github.com'] },
                  },
                  instanceKey: 'cindy-github',
                  dir: '/fixture/cindy-github',
                  enabled: true,
                  approval: { state: 'approved' },
                },
              ],
      }),
      onChanged: subscription('ghost-changed'),
      reportCardHeight: async () => {
        throw Error('Unexpected height write');
      },
      dispatchCardAction: async (
        callId: string,
        action: string,
        _prompt?: unknown,
        _values?: unknown,
        _silent?: unknown,
        route?: { model: string },
      ) => {
        if (callId !== 'pr-card') throw Error('wrong card');
        if (action === 'pr:follow') following = true;
        if (action === 'pr:stop') following = false;
        if (action === 'prui:settings') settings = !settings;
        if (action === 'prset:model') mode = 'custom';
        if (action === 'prset:modelTask') mode = 'task';
        if (
          action.startsWith('prset:') &&
          !['prset:model', 'prset:modelTask', 'prset:modelPick'].includes(action)
        )
          mode = 'toggles';
        if (action === 'prset:modelPick' && route)
          mode = route.model === 'demo-b' ? 'selected' : 'custom';
        update();
        return { ok: true };
      },
    },
  }),
  render: () => (
    <Tooltip.Provider>
      <div className="p-6">
        <GitContextBadge session={{ id: 'pr-task', workingDir: '/fixture' } as Session} />
      </div>
    </Tooltip.Provider>
  ),
});
