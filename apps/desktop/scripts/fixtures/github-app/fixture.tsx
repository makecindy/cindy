import { GithubAppCard } from '../../../src/renderer/features/cc-agent/GithubAppCard';
import { mountPage, forbid } from '../../ui-page/harness';

void mountPage({
  host: ctx => {
    let checks = 0;
    let finishSync: (() => void) | undefined;
    if (ctx.data.installationReturn) Object.assign(window, { finishGithubAppSync: () => finishSync?.() });
    return { gitContext: {
      githubAppStatus: async () => {
        checks++;
        if (ctx.data.loading) await new Promise(() => {});
        if (ctx.data.failed || (ctx.data.failRefresh && checks > 1)) throw new Error('Synthetic network error');
        if (ctx.data.installationReturn && checks > 1) {
          await new Promise<void>(resolve => { finishSync = resolve; });
          return { available: true, login: ctx.data.login, repositories: ['example/project'] };
        }
        return { available: true, ...ctx.data };
      },
      connectGithubApp: forbid('connectGithubApp'),
      installGithubApp: ctx.data.installationReturn ? async () => {} : forbid('installGithubApp'),
      disconnectGithubApp: forbid('disconnectGithubApp'),
    } };
  },
  render: () => <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]"><GithubAppCard /></div>,
});
