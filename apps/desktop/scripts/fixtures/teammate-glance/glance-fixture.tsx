import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotSessionContentHeaderRegistration } from '../../../src/renderer/features/bots/BotSessionContentHeader';
import { todoLocalDate, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';

// Roster, device list and delegation hooks are replaced at build time (ui-page.mjs `stubs`); the
// header, 近况 popover, menus, toast, theme and translations are the production implementations.

function todo(id: string, title: string, source: TeammateTodo['sources'][number]['kind'], label: string, patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id, revision: 1, key: id, origin: 'discovered', title, progress: '', outcome: '', value: '', next: null,
    sources: [{ kind: source, id: `s:${id}`, label }], associations: [], status: 'open',
    createdAt: '2026-10-19T01:00:00Z', updatedAt: '2026-10-19T01:00:00Z', sourceDeadline: null,
    deadlineCandidate: null, suggestedDate: null, decision: null, history: [], action: null, ...patch,
  };
}

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = todoLocalDate(new Date(), zone);
const friday = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

function items(caseName: string): TeammateTodo[] {
  if (caseName === 'new') return [];
  return [
    todo('t1', 'Reply to MagicLizi about the release date 回 MagicLizi 的邮件，确认发版时间', 'mail', 'MagicLizi', {
      sourceDeadline: { kind: 'date', date: today, timeZone: zone },
    }),
    todo('t2', 'Renew the Apple developer account', 'mail', 'Apple', { sourceDeadline: { kind: 'date', date: friday, timeZone: zone } }),
    todo('t3', 'Answer the question @you in the product feedback group', 'feishu', '产品反馈'),
    todo('t4', 'Talk with Lizi about the release cadence', 'conversation', '', { origin: 'assigned' }),
    todo('t5', 'Decide whether the blurry Windows tray icon matters', 'github', 'issue #6612'),
    todo('t6', 'Send Niny bank the proof of income', 'conversation', '', { origin: 'assigned' }),
    todo('d1', 'Pay the October property fee', 'conversation', '', {
      status: 'done', history: [{ summary: 'You said it was paid', at: '2026-10-19T02:00:00Z' }],
    }),
  ];
}

mountPage({
  route: '/bots/cindy-default',
  host: (ctx) => ({
    localDb: { bots: { todos: {
      list: async () => ({ items: items(ctx.case), version: 1 }),
      update: forbid('todos.update'),
      // 「每天帮我查一次」：默认关；打开浮层时只读不写。
      dailyCheck: async (_botId: string, enabled?: boolean) => {
        if (enabled !== undefined) throw new Error('dailyCheck write is not expected in this page');
        return false;
      },
    } } },
    maker: { onBotWorkbenchChanged: subscription('todos') },
    deviceLink: { invoke: forbid('deviceLink.invoke'), onRemotePush: subscription('remote') },
    openPath: forbid('openPath'),
  }),
  render: (ctx) => (
    <AppFrame>
      <BotSessionContentHeaderRegistration
        bot={ctx.case === 'new'
          ? { id: 'bot-new', name: '葫芦', sessionId: 'chat-new', canonicalChat: true }
          : { id: 'cindy-default', name: 'Cindy', templateId: 'cindy', sessionId: 'chat-1', canonicalChat: true }}
      />
      <div className="min-h-0 flex-1 p-6" data-ui-page-subject />
    </AppFrame>
  ),
});
