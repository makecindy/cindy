import { mountPage, subscription } from '../../ui-page/harness';
import { BotProjectsSettings } from '../../../src/renderer/features/bots/BotProjectsSettings';
import type { BotProjectOption } from '../../../src/shared/botWorkbench';

mountPage({
  host: ctx => {
    let projects: BotProjectOption[] = [
      { id: 'alpha', name: 'Cindy', path: '/Users/chris/Projects/cindy', linked: ctx.case !== 'empty', available: true },
      { id: 'beta', name: 'Filo · 移动端与协作体验', path: '/Users/chris/Projects/filo', linked: false, available: true },
      ...(ctx.case === 'legacy' ? [
        { id: 'remote', name: 'Design archive', path: 'D:\\Projects\\Design archive', deviceId: 'other-device', linked: true, available: false },
        { id: 'missing', name: '旧项目资料', path: '/Users/chris/Archived/project', linked: true, available: false },
      ] : []),
    ];
    let fail = ctx.case === 'error';
    let holdSave = ctx.case === 'saving';
    return {
      localDb: { bots: { projects: {
        list: async () => { if (fail) { fail = false; throw new Error('offline'); } return projects; },
        set: async (_botId: string, id: string, linked: boolean) => {
          if (holdSave) {
            holdSave = false;
            await new Promise<void>(resolve => window.addEventListener('bot-project-save-complete', () => resolve(), { once: true }));
          }
          projects = projects.map(project => project.id === id ? { ...project, linked } : project);
          return projects;
        },
      } } },
      maker: { onBotWorkbenchChanged: subscription('projects') },
    };
  },
  render: () => <div className="mx-auto max-w-xl p-5"><BotProjectsSettings botId="fixture" /></div>,
});
