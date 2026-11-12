import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOTIFY_TITLE_MAX_LENGTH, NOTIFY_BODY_MAX_LENGTH, NOTIFY_DEEP_LINK_MAX_LENGTH } from '@cindy/device-link';
import { mobileNotificationIdentity, MobileNotifyDeduper, buildBotGroupNotifyPayload, buildPermissionAlert, buildQuestionAlert, buildSessionNotifyPayload } from '../mobileNotify';

describe('buildSessionNotifyPayload', () => {
  it('identifies only teammate replies and isolates the same bot on different hosts', () => {
    const opts = { sessionId: 's1', title: 'Mika', kind: 'done' as const, selfDeviceId: 'd1', fallbackBody: 'Reply', teammateBotId: 'b1', teammateAvatar: { kind: 'symbol' as const, value: '🐸' } };
    const first = buildSessionNotifyPayload(opts);
    expect(first.sender?.avatar).toEqual(opts.teammateAvatar);
    expect(first.sender?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(buildSessionNotifyPayload({ ...opts, selfDeviceId: 'd2' }).sender?.id).not.toBe(first.sender?.id);
    expect(buildSessionNotifyPayload({ ...opts, sessionId: 's2' }).sender?.id).toBe(first.sender?.id);
    expect(buildSessionNotifyPayload({ ...opts, kind: 'needs-reply' }).sender).toEqual(first.sender);
    expect(buildSessionNotifyPayload({ ...opts, kind: 'error' }).sender).toEqual(first.sender);
    expect(buildSessionNotifyPayload({ ...opts, teammateBotId: undefined }).sender).toBeUndefined();
  });
  const base = {
    sessionId: 'session-1234',
    title: '修复登录问题',
    kind: 'done' as const,
    selfDeviceId: 'desktop-abcd',
    fallbackBody: '已完成 ✓',
  };

  it('kind 映射 category,deepLink 为 scheme 无关的应用内路径', () => {
    expect(buildSessionNotifyPayload(base)).toEqual({
      category: 'session-done',
      title: '修复登录问题',
      body: '已完成 ✓',
      deepLink: '/sessions/session-1234?deviceId=desktop-abcd',
      collapseId: createHash('sha256')
        .update('desktop-abcd:session-1234')
        .digest('hex')
        .slice(0, 32),
    });
    expect(buildSessionNotifyPayload({ ...base, kind: 'error' }).category).toBe('session-error');
    expect(buildSessionNotifyPayload({ ...base, kind: 'needs-reply' }).category).toBe(
      'session-needs-reply',
    );
  });

  it('routes a remote task to its execution host and scopes collapse/sender to that host', () => {
    const remote = buildSessionNotifyPayload({ ...base, targetDeviceId: 'execution-host', teammateBotId: 'bot-1' });
    const local = buildSessionNotifyPayload({ ...base, teammateBotId: 'bot-1' });
    expect(remote.deepLink).toBe('/sessions/session-1234?deviceId=execution-host&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot');
    expect(remote.collapseId).toBe(createHash('sha256').update('execution-host:session-1234').digest('hex').slice(0, 32));
    expect(remote.collapseId).not.toBe(local.collapseId);
    expect(remote.sender?.id).not.toBe(local.sender?.id);
  });

  it('detail 摘要作为正文:折叠空白、超协议上限截断;缺省回退终态文案', () => {
    const withDetail = buildSessionNotifyPayload({
      ...base,
      detail: '  修好了,\n共改了 3 个文件。  ',
    });
    expect(withDetail.body).toBe('修好了, 共改了 3 个文件。');
    const long = buildSessionNotifyPayload({ ...base, detail: 'x'.repeat(500) });
    expect(long.body).toHaveLength(240);
    expect(
      buildSessionNotifyPayload({ ...base, fallbackBody: '需要你回覆', detail: '   ' }).body,
    ).toBe('需要你回覆');
  });

  it.each(['😀'.repeat(240), 'a'.repeat(239) + '😀', '**中文😀** '.repeat(100)])('keeps emoji and mixed Markdown within the wire limit (case %#)', (detail) => {
    const { body } = buildSessionNotifyPayload({ ...base, detail });
    expect(body).toBeDefined();
    expect(body!.length).toBeLessThanOrEqual(NOTIFY_BODY_MAX_LENGTH);
    expect(body).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(body).not.toContain('**');
  });

  it('collapseId 哈希压缩:长 deviceId 也稳定在 32 hex(APNs 64B 上限内),不同会话不同键', () => {
    const longDevice = { ...base, selfDeviceId: 'f'.repeat(64) };
    const a = buildSessionNotifyPayload(longDevice).collapseId;
    const b = buildSessionNotifyPayload({ ...longDevice, sessionId: 'session-5678' }).collapseId;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(Buffer.byteLength(a, 'utf8')).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    // 同输入确定性(轮换/重发时系统层才能正确合并)
    expect(buildSessionNotifyPayload(longDevice).collapseId).toBe(a);
  });

  it('标题空白时回退 sessionId 前 8 位,超限截断到协议上限', () => {
    expect(buildSessionNotifyPayload({ ...base, title: '   ' }).title).toBe('session-');
    const long = buildSessionNotifyPayload({ ...base, title: 'x'.repeat(500) });
    expect(long.title).toHaveLength(NOTIFY_TITLE_MAX_LENGTH);
  });

  it('opens a teammate main chat as that teammate, with the same params the roster uses', () => {
    const payload = buildSessionNotifyPayload({ ...base, teammateBotId: 'bot/1' });
    expect(payload.deepLink).toBe(
      '/sessions/session-1234?deviceId=desktop-abcd&resourceCollectionId=teammates&resourceId=bot%2F1&resourceKind=bot',
    );
    const query = new URLSearchParams(payload.deepLink.split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({
      deviceId: 'desktop-abcd', resourceCollectionId: 'teammates', resourceId: 'bot/1', resourceKind: 'bot',
    });
    // Ordinary tasks keep the original link.
    expect(buildSessionNotifyPayload(base).deepLink).toBe('/sessions/session-1234?deviceId=desktop-abcd');
  });

  it('keeps the ordinary task link when the teammate link would exceed the protocol limit', () => {
    const payload = buildSessionNotifyPayload({ ...base, teammateBotId: 'b'.repeat(NOTIFY_DEEP_LINK_MAX_LENGTH) });
    expect(payload.deepLink).toBe('/sessions/session-1234?deviceId=desktop-abcd');
  });

  it('deepLink 对特殊字符做 URL 编码', () => {
    const payload = buildSessionNotifyPayload({ ...base, sessionId: 'a/b?c' });
    expect(payload.deepLink).toBe('/sessions/a%2Fb%3Fc?deviceId=desktop-abcd');
  });
});

describe('MobileNotifyDeduper', () => {
  it('uses the terminal boundary of a fallback signal to distinguish a later turn from scheduler output', () => {
    const deduper = new MobileNotifyDeduper();
    deduper.recordSent('session', 'done', 250);
    expect(deduper.shouldSend('session', 'done', 260, 'turn:100:200:signal-1')).toBe(false);
    expect(deduper.shouldSend('session', 'done', 410, 'turn:300:400:signal-2')).toBe(true);
  });
  it('同 session + kind 窗口内只放行一次,窗口滚动后恢复', () => {
    const deduper = new MobileNotifyDeduper(5_000);
    expect(deduper.shouldSend('s1', 'done', 0)).toBe(true);
    deduper.recordSent('s1', 'done', 0);
    expect(deduper.shouldSend('s1', 'done', 4_999)).toBe(false);
    expect(deduper.shouldSend('s1', 'done', 5_000)).toBe(true);
  });

  it('不同 kind / 不同 session 互不压制', () => {
    const deduper = new MobileNotifyDeduper(5_000);
    expect(deduper.shouldSend('s1', 'needs-reply', 0)).toBe(true);
    expect(deduper.shouldSend('s1', 'done', 1)).toBe(true);
    expect(deduper.shouldSend('s2', 'done', 2)).toBe(true);
  });

  it('reconciles an accepted anonymous scheduler push with the same durable turn', () => {
    const deduper = new MobileNotifyDeduper();
    deduper.recordSent('session', 'done', 1_000);
    expect(deduper.shouldSend('session', 'done', 1_001, 'turn:900:950')).toBe(false);
    expect(deduper.shouldSend('session', 'done', 10_000, 'turn:900:950')).toBe(false);
    expect(deduper.shouldSend('session', 'done', 1_200, 'turn:950:1100')).toBe(true);
    expect(deduper.shouldSend('session', 'done', 10_100, 'turn:10050:10075')).toBe(true);
  });

  it('keeps an anonymous scheduler push out of the recent identified completion window', () => {
    const deduper = new MobileNotifyDeduper();
    deduper.recordSent('session', 'done', 1_000, 'turn:900:950');
    expect(deduper.shouldSend('session', 'done', 1_001)).toBe(false);
    expect(deduper.shouldSend('session', 'done', 6_000)).toBe(true);
  });
});

it('uses final-message identity for completed replies, allowing distinct replies within five seconds', () => {
  const dedupe = new MobileNotifyDeduper();
  expect(dedupe.shouldSend('bot', 'done', 100, 'answer-1')).toBe(true);
  // A relay rejection leaves the first answer eligible for a later attempt.
  expect(dedupe.shouldSend('bot', 'done', 101, 'answer-1')).toBe(true);
  dedupe.recordSent('bot', 'done', 101, 'answer-1');
  expect(dedupe.shouldSend('bot', 'done', 102, 'answer-1')).toBe(false);
  expect(dedupe.shouldSend('bot', 'done', 101, 'answer-2')).toBe(true);
  dedupe.recordSent('bot', 'done', 101, 'answer-2');
  expect(dedupe.shouldSend('bot', 'done', 100_000, 'answer-2')).toBe(false);
});
it('sends plain text to APNs, not Markdown or image paths', () => {
  const payload = { sessionId: 'bot', title: 'Cindy', kind: 'done' as const, selfDeviceId: 'home', fallbackBody: 'New reply' };
  expect(buildSessionNotifyPayload({ ...payload, detail: '**Report** [ready](https://example.com) `a_b`' }).body).toBe('Report ready a_b');
  expect(buildSessionNotifyPayload({ ...payload, detail: '![private](/private/file.png)' }).body).toBe('private');
});

describe('buildBotGroupNotifyPayload', () => {
  it('opens the group on the phone and folds per (device, group)', () => {
    const payload = buildBotGroupNotifyPayload({
      groupId: 'g 1',
      title: '官网介绍页',
      body: '咪咪做完了「策划」，等你继续',
      selfDeviceId: 'desk-1',
    });
    expect(payload).toMatchObject({
      category: 'session-needs-reply',
      title: '官网介绍页',
      body: '咪咪做完了「策划」，等你继续',
      deepLink: '/companions/groups/g%201?deviceId=desk-1',
    });
    expect(payload.collapseId).toBe(createHash('sha256').update('desk-1:bot-group:g 1').digest('hex').slice(0, 32));
    expect(buildBotGroupNotifyPayload({ groupId: 'g', title: ' ', body: 'x', selfDeviceId: 'd' }).title).toBe('g');
    expect(buildBotGroupNotifyPayload({ groupId: 'g', title: 'x'.repeat(500), body: 'y', selfDeviceId: 'd' }).title)
      .toHaveLength(NOTIFY_TITLE_MAX_LENGTH);
  });
});

it('shares one exact event identity across mirrored senders but not newer events or another execution host', () => {
  const id = mobileNotificationIdentity('host', 'task', 'done', 'turn:1:2');
  expect(mobileNotificationIdentity('host', 'task', 'done', 'turn:1:2')).toBe(id);
  expect(mobileNotificationIdentity('other-host', 'task', 'done', 'turn:1:2')).not.toBe(id);
  expect(mobileNotificationIdentity('host', 'task', 'done', 'turn:1:3')).not.toBe(id);
});

// 测试价值
// - 生产入口与可观察结果：buildPermissionAlert / buildSessionNotifyPayload 决定手机通知上是否出现「批准」
//   以及正文写什么；手机和手表上点「批准」会直接放行电脑上的这次操作。
// - 规则依据：docs/product-rules/notification-actions.md（看不全、说不清或高风险的操作不能在通知上批准）。
// - 现有覆盖缺口：此前通知没有按钮，没有任何用例约束这条边界。
// - 最小失败输入：超长命令、高风险命令、原始 MCP 参数各一条；任一条带出 action 即越界。
// - tier：unit，纯函数。
describe('buildPermissionAlert', () => {
  const question = (kind: string, plugin?: string) => `Q:${kind}${plugin ? `:${plugin}` : ''}`;
  const request = (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ kind: 'permission', requestId: 'req-1', toolName, input, ...extra });

  it('写出完整操作并绑定到这一次请求', () => {
    expect(buildPermissionAlert(request('Bash', { command: 'pnpm test', cwd: '/repo' }), question)).toEqual({
      requestId: 'req-1',
      body: 'Q:command\npnpm test\n# cwd: /repo',
    });
    expect(buildPermissionAlert(request('Edit', { file_path: '/repo/a.ts' }), question)?.body).toBe('Q:file-write\n/repo/a.ts');
    expect(buildPermissionAlert(request('ghost_call', { ghost_id: 'mail', tool: 'send' }), question)?.body).toBe('Q:plugin:mail\nmail \u00b7 send');
  });

  it.each([
    ['放不进通知的操作', request('Bash', { command: `echo ${'x'.repeat(NOTIFY_BODY_MAX_LENGTH)}` })],
    ['高风险命令(卡片上要二次确认)', request('Bash', { command: 'git push origin main' })],
    ['原始 MCP 参数', request('mcp__srv__tool', { a: 1 })],
    ['认不出的工具', request('SomethingElse', { a: 1 })],
    ['不是权限请求', { kind: 'ask_user_question', requestId: 'req-1', questions: [] }],
    ['缺请求标识', request('Bash', { command: 'ls' }, { requestId: '' })],
    ['请求标识超出协议上限', request('Bash', { command: 'ls' }, { requestId: 'r'.repeat(129) })],
  ])('不提供批准:%s', (_label, input) => {
    expect(buildPermissionAlert(input, question)).toBeUndefined();
  });

  it('正文恰好占满通知上限时仍可批准,多一个字符就不行', () => {
    const fits = 'x'.repeat(NOTIFY_BODY_MAX_LENGTH - 'Q:command\n'.length);
    expect(buildPermissionAlert(request('Bash', { command: fits }), question)?.body).toHaveLength(NOTIFY_BODY_MAX_LENGTH);
    expect(buildPermissionAlert(request('Bash', { command: `${fits}x` }), question)).toBeUndefined();
  });
});

describe('buildSessionNotifyPayload 的通知按钮', () => {
  const base = { sessionId: 's1', title: 'T', selfDeviceId: 'd1', fallbackBody: 'Reply needed' };
  const permission = { requestId: 'req-1', body: 'Allow?\nrm *.log && echo `date`' };

  it('等批准:正文逐字保留(不做 Markdown 投影),按钮绑定请求', () => {
    expect(buildSessionNotifyPayload({ ...base, kind: 'needs-reply', permission, detail: 'older assistant text' })).toMatchObject({
      category: 'session-needs-reply',
      body: permission.body,
      action: { kind: 'permission', requestId: 'req-1' },
    });
  });

  it('已完成可回复;失败与普通的等回复没有按钮;权限信息不会挂到别的事件上', () => {
    expect(buildSessionNotifyPayload({ ...base, kind: 'done', reply: true }).action).toEqual({ kind: 'reply' });
    expect(buildSessionNotifyPayload({ ...base, kind: 'needs-reply' })).not.toHaveProperty('action');
    expect(buildSessionNotifyPayload({ ...base, kind: 'error' })).not.toHaveProperty('action');
    const done = buildSessionNotifyPayload({ ...base, kind: 'done', permission });
    expect(done).not.toHaveProperty('action');
    expect(done.body).toBe('Reply needed');
  });
});

// 提问通知:生产入口 buildQuestionAlert / buildSessionNotifyPayload,决定手机通知上写什么问题、给哪些选项按钮。
// 规则依据 docs/product-rules/notification-actions.md「提问」;此前提问的通知只有固定文案,没有任何用例。
describe('buildQuestionAlert', () => {
  const ask = (question: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ kind: 'ask_user_question', requestId: 'q-1', questions: [question], ...extra });
  const database = { question: '用哪个数据库？', options: [{ label: 'Postgres', description: '需要服务器' }, { label: 'SQLite' }, { label: '其他（回复说明）' }] };

  it('正文是问题加编号选项,按钮与编号同序;模型自带的「其他」不占按钮', () => {
    expect(buildQuestionAlert(ask(database))).toEqual({
      requestId: 'q-1',
      body: '用哪个数据库？\n1. Postgres\n2. SQLite',
      options: ['Postgres', 'SQLite'],
      details: ['需要服务器', ''],
    });
    expect(buildQuestionAlert(ask({ question: '发布说明怎么写？' }))).toEqual({ requestId: 'q-1', body: '发布说明怎么写？' });
  });

  it('放不下时正文截断,完整问题随通知另带;选项太多或太长时只留文字回复', () => {
    const long = buildQuestionAlert(ask({ question: '问'.repeat(300), options: [{ label: 'A' }] }));
    expect(long?.body).toHaveLength(NOTIFY_BODY_MAX_LENGTH);
    expect(long?.question).toBe('问'.repeat(300));
    expect(long?.options).toEqual(['A']);
    const many = buildQuestionAlert(ask({ question: '选一个', options: Array.from({ length: 9 }, (_, i) => ({ label: `选项${i}` })) }));
    expect(many).not.toHaveProperty('options');
    expect(many?.body.startsWith('选一个\n1. 选项0')).toBe(true);
  });

  it.each([
    ['一次问了多道', { kind: 'ask_user_question', requestId: 'q-1', questions: [database, { question: '第二道' }] }],
    ['多选题', ask({ ...database, multiSelect: true })],
    ['只通知不等待的提问', ask(database, { delivery: 'async' })],
    ['只接受固定选项但给不出按钮', ask({ question: '选一个', options: Array.from({ length: 9 }, (_, i) => ({ label: `选项${i}` })),
      answerConstraints: { required: true, choices: Array.from({ length: 9 }, (_, i) => `选项${i}`) } })],
    ['不是提问', { kind: 'plan_review', requestId: 'q-1', plan: 'x' }],
    ['缺请求标识', ask(database, { requestId: '' })],
  ])('留在 App 里回答:%s', (_label, request) => {
    expect(buildQuestionAlert(request)).toBeUndefined();
  });

  it('通知负载带上请求标识与选项;权限与提问同时给出时以权限为准', () => {
    const base = { sessionId: 's1', title: 'T', selfDeviceId: 'd1', fallbackBody: 'Reply needed', kind: 'needs-reply' as const };
    const question = buildQuestionAlert(ask(database))!;
    expect(buildSessionNotifyPayload({ ...base, question })).toMatchObject({
      body: '用哪个数据库？\n1. Postgres\n2. SQLite',
      action: { kind: 'question', requestId: 'q-1', options: ['Postgres', 'SQLite'], details: ['需要服务器', ''] },
    });
    expect(buildSessionNotifyPayload({ ...base, question, permission: { requestId: 'req-1', body: 'Allow?\nls' } }).action)
      .toEqual({ kind: 'permission', requestId: 'req-1' });
    expect(buildSessionNotifyPayload({ ...base, kind: 'done', question })).not.toHaveProperty('action');
  });
});
