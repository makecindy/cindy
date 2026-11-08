import { GithubAppCard } from '../../../src/renderer/features/cc-agent/GithubAppCard';
import { mountPage, forbid } from '../../ui-page/harness';

void mountPage({
  host: ctx => ({ gitContext: {
    githubAppStatus: async () => {
      if (ctx.data.failed) throw new Error('Synthetic network error');
      return { available: true, ...ctx.data };
    },
    connectGithubApp: forbid('connectGithubApp'),
    installGithubApp: forbid('installGithubApp'),
    disconnectGithubApp: forbid('disconnectGithubApp'),
  } }),
  render: () => <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]"><GithubAppCard /></div>,
});
