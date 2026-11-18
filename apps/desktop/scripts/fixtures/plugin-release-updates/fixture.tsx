import { GithubPluginReleaseSettings } from '../../../src/renderer/cindy-brain/GithubPluginReleaseSettings';
import type { InstalledGhost } from '../../../src/shared/ghost';
import { mountPage } from '../../ui-page/harness';

const ghost = {
  enabled: true, dir: '/fixture', namespace: 'local', namespaceState: 'confirmed',
  manifest: { id: 'example-plugin', version: '1.2.0', githubRelease: 'example/plugin' },
} as InstalledGhost;

void mountPage({
  host: { ghosts: { githubRelease: async () => ({
    status: 'available', release: { version: '1.3.0', assetId: 42 },
  }) } },
  render: () => <div className="bg-[var(--settings-bg)] p-6">
    <GithubPluginReleaseSettings ghost={ghost} repository="example/plugin" />
  </div>,
});
