import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { GhostPluginCard, MarketPluginCard } from '../../../src/renderer/features/plugin/GhostPluginPage';
import { MarketPluginDetailView } from '../../../src/renderer/features/plugin/MarketPluginDetailView';
import { UpdateAllDialog } from '../../../src/renderer/features/plugin/UpdateAllDialog';
import {
  beginPluginInstallProgress,
  failPluginInstallProgress,
  type PluginInstallIntent,
} from '../../../src/renderer/features/plugin/lib/pluginInstallProgress';
import type { DownloadProgress } from '../../../src/shared/downloadProgress';
import type { PluginMarketInstallProgress, PluginMarketItem } from '../../../src/shared/pluginMarket';
import type { UpdateAllRow } from '../../../src/renderer/features/plugin/lib/updateAllModel';

const noop = () => {};
const MB = 1024 * 1024;
const SIZE = 4.8 * MB;

/** Main's pushes, delivered through the page's own subscription. */
let push: (event: PluginMarketInstallProgress) => void = noop;

function download(phase: DownloadProgress['phase'], fraction: number, extra: Partial<DownloadProgress> = {}): DownloadProgress {
  const transferring = phase === 'downloading';
  return {
    phase, loaded: fraction * SIZE, total: SIZE, percent: fraction * 100,
    speedBps: transferring ? 1.5 * MB : 0, etaSeconds: transferring ? 2 : null, ...extra,
  };
}

type Step = { download: DownloadProgress; consent?: true } | 'failed';

/** Puts one plugin into a state exactly as the page and Main would: begin, then pushes. */
function seed(pluginId: string, intent: PluginInstallIntent, step: Step) {
  beginPluginInstallProgress(pluginId, intent);
  if (step === 'failed') {
    push({ pluginId, download: download('downloading', 0.61) });
    // The runner records the translated reason its failure toast showed.
    failPluginInstallProgress(pluginId, 'Download timed out');
    return;
  }
  push({ pluginId, download: step.download, ...(step.consent ? { awaitingConsent: true as const } : {}) });
}

const market: PluginMarketItem = {
  pluginId: 'fixture-feishu', ghostId: 'feishu-helper', namespace: null, name: 'Feishu Helper',
  description: 'Read and write Feishu documents, calendars and messages from a conversation.',
  author: 'Cindy', publisherKind: 'official', scope: 'public', sourceType: 'git-market',
  sourceMarketName: 'Fixture marketplace', organizationId: null, defaultInstall: false,
  releaseId: 'fixture-release', version: '1.4.0', publishedAt: '2026-11-18T00:00:00Z',
  icon: null, installState: 'update-available', enabled: true,
};

const installedStates: Array<{ id: string; name: string; step: Step }> = [
  { id: 'downloading', name: 'Downloading', step: { download: download('downloading', 0.55) } },
  { id: 'retrying', name: 'Retrying', step: { download: download('retrying', 0.38, { attempt: 2, retryReason: 'network' }) } },
  { id: 'consent', name: 'Waiting for confirmation', step: { download: download('verifying', 1), consent: true } },
  { id: 'installing', name: 'Installing', step: { download: download('installing', 1) } },
  { id: 'failed', name: 'Failed', step: 'failed' },
  { id: 'done', name: 'Updated', step: { download: download('completed', 1) } },
];
const marketStates: Array<{ id: string; name: string; step: Step; compact?: true }> = [
  { id: 'm-downloading', name: 'Notion', step: { download: download('downloading', 0.3) } },
  { id: 'm-failed', name: 'Linear', step: 'failed' },
  { id: 'm-done', name: 'Google Drive', step: { download: download('completed', 1) } },
  { id: 'c-downloading', name: 'GitHub', step: { download: download('downloading', 0.72) }, compact: true },
];

function Cards() {
  useState(() => {
    for (const state of installedStates) {
      if (state.id !== 'consent') seed(`installed-${state.id}`, 'update', state.step);
    }
    for (const state of marketStates) seed(`market-${state.id}`, 'install', state.step);
    return null;
  });
  return (
    <main className="mx-auto min-w-0 max-w-[944px] p-6">
      <div className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2">
        {installedStates.map(state => (
          <GhostPluginCard key={state.id}
            item={{ id: `installed-${state.id}`, name: state.name, description: market.description, enabled: true, canUse: true, tabPanel: true }}
            marketItem={{ ...market, pluginId: `installed-${state.id}`, name: state.name,
              updateRequiresConsent: state.id === 'consent' ? true : undefined }}
            updateVersion="1.4.0"
            onUpdate={state.id === 'consent' ? () => seed(`installed-${state.id}`, 'update', state.step) : noop}
            onPrimary={noop} onManage={noop} />
        ))}
        {marketStates.map(state => (
          <MarketPluginCard key={state.id} compact={state.compact}
            item={{ ...market, pluginId: `market-${state.id}`, name: state.name, installState: 'not-installed', enabled: null }}
            busy={false} showInstallProgress onSelect={noop} onInstall={noop} onIconLoadError={noop} />
        ))}
      </div>
    </main>
  );
}

const rows: UpdateAllRow[] = [
  { pluginId: 'row-done', ghostId: 'translator', name: 'Translator', fromVersion: '2.0.1', toVersion: '2.1.0', status: 'done' },
  { pluginId: 'row-running', ghostId: 'feishu-helper', name: 'Feishu Helper', fromVersion: '1.3.2', toVersion: '1.4.0', status: 'installing' },
  { pluginId: 'row-failed', ghostId: 'linear', name: 'Linear', fromVersion: '0.9.0', toVersion: '1.0.0', status: 'failed', errorText: 'Download timed out' },
  { pluginId: 'row-pending', ghostId: 'calendar', name: 'Calendar', fromVersion: '2.0.4', toVersion: '2.1.0', status: 'pending' },
];

function UpdateAll() {
  useState(() => {
    seed('row-running', 'update', { download: download('downloading', 0.55) });
    seed('row-failed', 'update', 'failed');
    return null;
  });
  return <UpdateAllDialog open rows={rows} iconByGhostId={new Map()} onClose={noop} />;
}

function MarketDetail({ step }: { step: Step }) {
  useState(() => { seed(market.pluginId, 'install', step); return null; });
  return (
    <MarketPluginDetailView
      detail={{ ...market, installState: 'not-installed', enabled: null, manifest: {
        schemaVersion: 3, id: market.ghostId, name: market.name, version: market.version, kind: 'chip', entry: 'main.js',
      } }}
      busy={false} showInstallProgress onBack={noop} onInstall={noop} onIconLoadError={noop} />
  );
}

mountPage({
  host: () => ({
    pluginMarket: {
      onInstallProgress: (listener: (event: PluginMarketInstallProgress) => void) => {
        push = listener;
        return noop;
      },
    },
  }),
  render: ctx =>
    ctx.case === 'update-all' ? <UpdateAll />
      : ctx.case === 'market-detail' ? <MarketDetail step={{ download: download('retrying', 0.4, { attempt: 2, retryReason: 'slow' }) }} />
        : ctx.case === 'market-detail-failed' ? <MarketDetail step="failed" />
          : <Cards />,
});
