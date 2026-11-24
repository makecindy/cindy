import { GithubPluginReleaseSettings } from '../../../src/renderer/cindy-brain/GithubPluginReleaseSettings';
import type { InstalledGhost } from '../../../src/shared/ghost';
import type { GithubPluginReleaseProgress } from '../../../src/shared/githubPluginRelease';
import { initialDownloadProgress } from '../../../src/shared/downloadProgress';
import { mountPage } from '../../ui-page/harness';

const ghost = {
  enabled: true, dir: '/fixture', namespace: 'local', namespaceState: 'confirmed',
  manifest: { id: 'example-plugin', version: '1.2.0', githubRelease: 'example/plugin' },
} as InstalledGhost;

let onProgress: ((event: GithubPluginReleaseProgress) => void) | undefined;
void mountPage({
  host: { ghosts: {
    onGithubReleaseProgress: (callback) => { onProgress = callback; return () => { onProgress = undefined; }; },
    githubRelease: async (action, instanceId) => {
      if (action === 'update') {
        onProgress?.({ instanceId, progress: { ...initialDownloadProgress('downloading'), loaded: 5242880, total: 10485760, percent: 50 } });
        return new Promise(() => {});
      }
      return { status: 'available', release: { version: '1.3.0', assetId: 42 } };
    },
  } },
  render: () => <div className="bg-[var(--settings-bg)] p-6">
    <GithubPluginReleaseSettings ghost={ghost} repository="example/plugin" />
  </div>,
});
