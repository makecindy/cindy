import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { BotRoutines } from '../../../src/renderer/features/bots/BotRoutines';
import { BotAutonomySettings } from '../../../src/renderer/features/bots/BotAutonomySettings';
import type { Routine } from '@cindy/maker-scheduler';

const base = { botId: 'fixture', prompt: 'Fixture only', revision: 1, createdAt: 1, updatedAt: 1 };
const cron = (expression: string) => [{ id: 'time', kind: 'cron' as const, expression, timezone: 'Asia/Shanghai' }];
let records: Routine[] = [];
mountPage({
  host: (ctx) => {
    records = [
      { ...base, id: 'builtin', name: 'follow-up', builtin: 'follow-up', enabled: true, triggers: [] },
      { ...base, id: 'paused', name: 'Review inbox', enabled: false, triggers: cron('5 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *') },
      { ...base, id: 'timer', name: 'Daily project summary', enabled: true, triggers: cron('37 0,6,12,18,23 * * *') },
      { ...base, id: 'event', name: 'Review pull requests and report changes', enabled: true, activity: 'queued', triggers: [
        ...cron('*/20 9-17 * * 1-5'),
        { id: 'event', kind: 'event', sourceId: 'plugin:git', eventType: 'pr.changed', filters: [] },
      ] },
      { ...base, id: 'running', name: 'Weekly digest', enabled: true, activity: 'running', triggers: cron('0 9 * * 1') },
    ];
    let fail = ctx.case === 'save-error';
    return {
      routines: {
        list: async () => records,
        sources: async () => [{ id: 'plugin:git', name: 'GitHub', status: 'listening', events: [{ type: 'pr.changed', name: 'Pull request updated', fields: [] }] }],
        history: async () => [{ id: 'failed', routineId: 'timer', status: 'failed', createdAt: 1792800000000, events: [], error: 'Service unavailable' }],
        onChanged: subscription('routines'),
        nightlyLearning: { get: async () => null },
        save: async (_bot: string, input: Routine, id: string) => {
          if (fail) { fail = false; throw new Error('Fixture write failed'); }
          records = records.map((item) => item.id === id ? { ...item, ...input } : item);
          return records.find((item) => item.id === id);
        },
        runNow: forbid('routines.runNow'), remove: forbid('routines.remove'),
      },
      localDb: { bots: { autonomy: { getSettings: async () => ({ schedulerBotId: null, isCustomized: false, defaults: { schedulerBotId: null } }) } } },
      maker: { onBotAutonomyChanged: subscription('autonomy') },
    };
  },
  render: () => <div className="mx-auto w-full max-w-xl p-4"><BotRoutines botId="fixture" embedded
    header={<BotAutonomySettings botId="fixture" botName="Cindy" allowSchedulerFollow={false} onAllowSchedulerFollowChange={() => {}} />}
  /></div>,
});
