import { describe, expect, it } from 'vitest';
import { PLUGIN_EVENT_LIMITS, subscribedEventPlugins, toPluginWebhookEvent } from '../plugin-events.js';
import { issueChangeEvents, issueChangeFromEvents, parseGithubItemReference } from '../github-item.js';
import { normalizeScheduleWebhookSource } from '../webhook-formats.js';

// 测试价值
// - 生产入口与可观察结果：toPluginWebhookEvent 生成落盘并注入提示词的门铃记录；subscribedEventPlugins 决定哪些插件保持监听。
// - 规则依据：docs/product-rules/plugin-event-triggers.md「事件只是门铃」与「常驻只在有人订阅时」。
// - 现有覆盖缺口：新模块；队列与调度器测试只覆盖匹配和范围，不覆盖字段预算与来源命名。
// - 最小失败输入：两个插件用同一上游 ID；超出预算的字段；暂停或过期的自动化。
// - tier：unit，纯函数。
describe('plugin events', () => {
  it('namespaces delivery ids by plugin and bounds persisted fields', () => {
    const big = 'x'.repeat(PLUGIN_EVENT_LIMITS.persistedFieldValueChars + 50);
    const a = toPluginWebhookEvent('public/chat', { id: 'm1', type: 'message.received', occurredAt: 5, subject: '  hi  ',
      data: { chatId: 'c1', fromSelf: false, body: big, a: big, b: big, c: big } }, 10);
    const b = toPluginWebhookEvent('public/mail', { id: 'm1', type: 'message.received', occurredAt: 5, data: {} }, 10);
    expect(a.deliveryId).not.toBe(b.deliveryId);
    expect(a).toMatchObject({ source: 'plugin:public/chat', event: 'message.received', occurredAt: 5, subject: 'hi', fieldsTruncated: true });
    expect(a.fields).toMatchObject({ chatId: 'c1', fromSelf: false });
    expect((a.fields!.body as string).length).toBe(PLUGIN_EVENT_LIMITS.persistedFieldValueChars);
    expect(JSON.stringify(a.fields).length).toBeLessThan(PLUGIN_EVENT_LIMITS.persistedFieldChars + 200);
    expect(b.fields).toBeUndefined();
  });

  it('lists plugins chosen by active, unexpired automations only', () => {
    const trigger = (plugin: string) => ({ source: { preset: 'plugin', sources: [{ plugin }] } });
    expect([...subscribedEventPlugins([
      { status: 'active', webhookTrigger: trigger('public/chat') },
      { status: 'paused', webhookTrigger: trigger('public/paused') },
      { status: 'active', expireAt: 1, webhookTrigger: trigger('public/expired') },
      { status: 'active', webhookTrigger: { source: { preset: 'github-app' } } },
    ], 100)]).toEqual(['public/chat']);
  });
});

// 测试价值
// - 生产入口与可观察结果：parseGithubItemReference / normalizeScheduleWebhookSource / issueChangeFromEvents，
//   决定「指定 PR 或 Issue」输入框接受什么、保存成什么，以及编辑时能否还原条件。
// - 规则依据：docs/product-rules/schedule-webhook-trigger.md（2026-11-24 一个输入框填编号或链接）。
// - 现有覆盖缺口：新函数；表单测试只覆盖 owner/repo#编号一种写法。
// - 最小失败输入：只填编号但没有仓库；/issues/ 链接（可能其实是 PR）；多个仓库加编号。
// - tier：unit，纯函数。
describe('specific GitHub PR or Issue', () => {
  it.each([
    ['42', 'example/project', { repository: 'example/project', number: 42 }],
    ['#42', 'example/project', { repository: 'example/project', number: 42 }],
    ['42', undefined, null],
    ['Owner/Repo#9', undefined, { repository: 'owner/repo', number: 9 }],
    ['https://github.com/Owner/Repo/pull/9/files', undefined, { repository: 'owner/repo', number: 9, kind: 'pr' }],
    // An /issues/ link may still be a PR (GitHub redirects), so the type is left to the host lookup.
    ['https://github.com/owner/repo/issues/9', undefined, { repository: 'owner/repo', number: 9 }],
    ['https://gitlab.com/owner/repo/-/merge_requests/9', undefined, null],
    ['0', 'example/project', null],
  ])('parses %s', (input, repository, expected) => {
    expect(parseGithubItemReference(input, repository)).toEqual(expected);
  });

  it('keeps a numbered App source to one repository and round-trips Issue conditions', () => {
    expect(normalizeScheduleWebhookSource({ preset: 'github-app', repositories: ['Example/Project'], number: 7 }))
      .toEqual({ preset: 'github-app', repositories: ['example/project'], number: 7 });
    expect(() => normalizeScheduleWebhookSource({ preset: 'github-app', repositories: ['a/b', 'c/d'], number: 7 })).toThrow('exactly one');
    expect(issueChangeFromEvents(issueChangeEvents('closed'))).toBe('closed');
    expect(issueChangeFromEvents(['issue_comment', 'issues'])).toBe('any');
    expect(issueChangeFromEvents(['issues.labeled'])).toBeNull();
  });
});
