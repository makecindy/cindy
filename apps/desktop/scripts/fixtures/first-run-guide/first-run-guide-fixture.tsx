import { useEffect } from 'react';

import { ctx, forbid, mountPage } from '../../ui-page/harness';
import { FirstRunGuideSection } from '../../../src/renderer/components/settings/FirstRunGuideSection';
import { Button } from '../../../src/renderer/components/ui/button';
import { FirstRunGuide } from '../../../src/renderer/features/first-run-guide/FirstRunGuide';
import {
  openFirstRunGuide,
  parkFirstRunGuide,
  type FirstRunGuideContext,
} from '../../../src/renderer/features/first-run-guide/firstRunGuideStore';

// Fixture data only: tool counts, agent and computer names are generic examples.
const data = ctx.data as {
  surface?: 'settings';
  context?: FirstRunGuideContext;
  parked?: boolean;
  connected?: boolean;
  ownConnected?: boolean;
  tasks?: Array<{ source: string; count: number; mb: number }>;
  companions?: Array<{ id: string; kind: 'openclaw' | 'hermes'; name: string }>;
  lastRun?: { sourceName: string; pending: number } | null;
  balance?: { planCredits: string; purchasedCredits: string; promotionalCredits: string; available: string; scale: 9; observedAt: string };
};

const MB = 1024 * 1024;
const candidates = (data.tasks ?? []).flatMap((group) =>
  Array.from({ length: group.count }, (_, index) => ({
    key: `${group.source}:fixture-${index}`,
    source: group.source,
    id: `fixture-${index}`,
    title: `Fixture task ${index + 1}`,
    cwd: null,
    groupKey: 'dialogue',
    groupName: '',
    groupPath: null,
    dialogue: true,
    updatedAt: 0,
    archived: false,
    sizeBytes: Math.round((group.mb * MB) / group.count),
    missingDir: false,
    hidden: null,
    unsupportedVersion: null,
  })),
);

(window as unknown as { __guideProviders: unknown[] }).__guideProviders = [
  { id: 'xd', name: 'Cindy AI', connected: data.connected === true, source: 'builtin', auth: { method: 'gateway' } },
  { id: 'anthropic', name: 'Anthropic', connected: false, source: 'builtin', auth: { method: 'oauth' } },
  { id: 'openai', name: 'OpenAI', connected: data.ownConnected === true, source: 'builtin', auth: { method: 'oauth' } },
  { id: 'xai', name: 'xAI', connected: false, source: 'builtin', auth: { method: 'oauth' } },
];

const fresh: FirstRunGuideContext = { manual: false, migration: false, legacyMigrated: false };

/**
 * Preview-only controls: after the guide is closed, open it again from the start on any of
 * its paths. Hidden in screenshots; the product's own way back is Settings → General.
 */
function ReopenControls() {
  const paths: Array<[string, FirstRunGuideContext]> = [
    ['重新打开引导（新用户）', fresh],
    ['重新打开引导（老用户：从旧电脑迁移）', { ...fresh, migration: true }],
    ['重新打开引导（刚迁移过旧版数据）', { ...fresh, legacyMigrated: true }],
    ['从设置里手动打开的样子（全部步骤）', { ...fresh, manual: true }],
  ];
  return (
    <div data-ui-page-control className="fixed left-4 top-4 flex flex-col items-start gap-2">
      {paths.map(([label, context]) => (
        <Button key={label} variant="secondary" size="md" type="button" onClick={() => openFirstRunGuide(context)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

function OpenGuide() {
  useEffect(() => {
    openFirstRunGuide(data.context ?? fresh);
    if (data.parked) parkFirstRunGuide();
  }, []);
  return (
    <>
      <ReopenControls />
      <FirstRunGuide />
    </>
  );
}

mountPage({
  route: '/cc-agent/new',
  host: () => ({
    platform: 'darwin',
    localDb: {
      sessionImport: {
        scan: async () => ({
          candidates,
          hiddenCounts: { cindy: 0, temp: 0, internal: 0, imported: 0 },
          sources: (data.tasks ?? []).map((group) => ({ id: group.source, label: group.source, count: group.count })),
          sourceErrors: [],
          scannedAt: 0,
        }),
        start: async () => ({ requestId: 'fixture-job', status: 'running', items: [], startedAt: 0, finishedAt: null }),
        cancel: forbid('localDb.sessionImport.cancel'),
      },
    },
    companionImport: {
      sources: async () => data.companions ?? [],
      start: forbid('companionImport.start'),
    },
    setupMigration: {
      state: async () => ({
        lastRun: data.lastRun
          ? {
              sourceName: data.lastRun.sourceName,
              finishedAt: 0,
              checklist: Array.from({ length: data.lastRun.pending }, (_, index) => ({
                id: `provider-sign-in:${index}`, kind: 'provider-sign-in', label: `Provider ${index + 1}`,
              })),
            }
          : null,
      }),
      apply: forbid('setupMigration.apply'),
    },
    billing: {
      getBalance: async () => data.balance ?? {
        planCredits: '0', purchasedCredits: '0', promotionalCredits: '5.000000000', available: '5.000000000',
        scale: 9, observedAt: '2026-11-11T00:00:00.000Z',
      },
    },
    maker: {
      listProviderPresets: async () => ({ presets: [] }),
      scanLocalCli: async () => ({
        detections: [{ cli: 'claude-cli', providerId: 'anthropic', installed: true, loggedIn: true, sharedWithCindy: false }],
      }),
    },
  }),
  render: () =>
    data.surface === 'settings' ? (
      <div className="mx-auto max-w-[720px] p-6">
        <FirstRunGuideSection />
        <FirstRunGuide />
      </div>
    ) : (
      <OpenGuide />
    ),
});
