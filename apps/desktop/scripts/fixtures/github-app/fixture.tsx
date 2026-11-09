import { GithubAppCard } from '../../../src/renderer/features/cc-agent/GithubAppCard';
import { mountPage, forbid } from '../../ui-page/harness';

void mountPage({
  host: ctx => {
    let checks = 0;
    return { gitContext: {
      githubAppStatus: async () => {
        checks++;
        if (ctx.data.loading) await new Promise(() => {});
        if (ctx.data.failed || (ctx.data.failRefresh && checks > 1)) throw new Error('Synthetic network error');
        return { available: true, ...ctx.data };
      },
      connectGithubApp: forbid('connectGithubApp'),
      installGithubApp: forbid('installGithubApp'),
      disconnectGithubApp: forbid('disconnectGithubApp'),
    } };
  },
  render: () => <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]"><GithubAppCard /></div>,
});
