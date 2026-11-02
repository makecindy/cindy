import type { Routine } from '@cindy/maker-scheduler';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotRoutines } from '../../../src/renderer/features/bots/BotRoutines';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import type { NightlyLearningView } from '../../../src/shared/botNightlyLearning';

// The routines list, the nightly row and the history page are the production components; only the
// host bridge is replaced with in-memory data. Every write returns the updated view, as the host does.

const at = (daysAgo: number, hour = 3, minute = 30) => {
  const day = new Date();
  day.setDate(day.getDate() - daysAgo);
  day.setHours(hour, minute, 0, 0);
  return day.getTime();
};

function routine(id: string, builtin: Routine['builtin'] | undefined, enabled: boolean, name = id): Routine {
  return {
    id, botId: 'cindy-default', name, prompt: 'p', enabled, triggers: [{ id: 't', kind: 'cron', expression: '30 3 * * *', timezone: 'Asia/Shanghai' }],
    silentWhenIdle: true, revision: 1, createdAt: 0, updatedAt: 0, ...(builtin ? { builtin } : {}),
  } as Routine;
}

function viewFor(caseName: string): NightlyLearningView {
  const learned = {
    id: 'nl_a', at: at(0), outcome: 'learned' as const, turns: 18, items: [
      { id: 'i1', kind: 'skill' as const, action: 'created' as const, target: 'find-old-chats', title: '查找渠道里的旧对话', reason: '10月22日、23日两次在找 Telegram 里的旧聊天' },
      { id: 'i2', kind: 'skill' as const, action: 'disabled' as const, target: 'diagnose-raw-markup', title: '排查露出原始指令', mergedInto: '核对修复是否已发布', reason: '两个做法的步骤重复' },
      { id: 'i3', kind: 'skill' as const, action: 'disabled' as const, target: 'start-test-app', title: '启动 main 测试版', reason: '一个月没用过，仓库文档已覆盖' },
      { id: 'i4', kind: 'memory' as const, action: 'deleted' as const, target: 'feedback_dup.md', title: '只报功能结果', mergedInto: '任务进度只报功能结果', reason: '两条说的是同一件事' },
      { id: 'i5', kind: 'memory' as const, action: 'deleted' as const, target: 'feedback_organizer.md', title: '群聊负责人被移除', reason: '这是代码事实，不是你的偏好', undone: true },
    ],
  };
  const quiet = { id: 'nl_b', at: at(1), outcome: 'nothing' as const, turns: 6, items: [] };
  const failed = { id: 'nl_c', at: at(0), outcome: 'failed' as const, turns: 9, items: [], errorCode: 'MODEL_UNAVAILABLE' as const };
  const base: NightlyLearningView = {
    enabled: true, frequency: 'daily', pendingTurns: 12, running: false, memoryEnabled: true,
    lastRun: learned, runs: [learned, quiet],
    candidates: [
      { id: 'c_1', title: '汇总多台电脑的模型用量', summary: '10月23日出现 1 次', firstSeenAt: at(0), lastSeenAt: at(0) },
      { id: 'c_2', title: '按渠道查最近的群消息', summary: '10月21日出现 1 次', firstSeenAt: at(2), lastSeenAt: at(2) },
    ],
  };
  if (caseName === 'idle') return { ...base, pendingTurns: 0, lastRun: quiet, runs: [quiet], candidates: [] };
  if (caseName === 'paused') return { ...base, enabled: false };
  if (caseName === 'failed') return { ...base, lastRun: failed, runs: [failed, learned, quiet], frequency: 'weekly', memoryEnabled: false };
  if (caseName === 'new') return { ...base, pendingTurns: 0, lastRun: null, runs: [], candidates: [] };
  if (caseName === 'not-here') return { ...base, enabled: null };
  return base;
}

mountPage({
  route: '/',
  host: (ctx) => {
    let view = viewFor(ctx.case);
    const routines = [
      routine('builtin-follow-up-cindy-default', 'follow-up', true),
      routine('builtin-todo-check-cindy-default', undefined, false, '每天查待办'),
      ...(view.enabled === null ? [] : [routine('builtin-nightly-learning-cindy-default', 'nightly-learning', view.enabled)]),
      routine('weekly-report', undefined, true, '每周一整理周报'),
    ];
    const update = async (patch: Partial<NightlyLearningView>) => (view = { ...view, ...patch });
    return {
      routines: {
        list: async () => routines,
        sources: async () => [],
        history: async () => [],
        save: async () => { throw new Error('save is not expected in this page'); },
        onChanged: subscription('routines'),
        nightlyLearning: {
          get: async () => view,
          setEnabled: async (_bot: string, enabled: boolean) => update({ enabled }),
          setFrequency: async (_bot: string, frequency: NightlyLearningView['frequency']) => update({ frequency }),
          runNow: async () => update({ running: true }),
          revert: async (_bot: string, runId: string, itemId: string, redo: boolean) => update({
            runs: view.runs.map((run) => run.id !== runId ? run : {
              ...run, items: run.items.map((item) => item.id === itemId ? { ...item, undone: !redo } : item),
            }),
          }),
          candidate: async (_bot: string, id: string) => update({ candidates: view.candidates.filter((c) => c.id !== id) }),
        },
      },
    };
  },
  render: () => (
    <ConfirmDialogProvider>
      <div className="mx-auto w-full max-w-xl px-5" data-ui-page-subject>
        <BotRoutines embedded botId="cindy-default" />
      </div>
    </ConfirmDialogProvider>
  ),
});
