import { describe, expect, it } from 'vitest';
import { PLUGIN_EVENT_LIMITS, pluginEventSubscriptions, subscribedEventPlugins, toPluginWebhookEvent } from '../plugin-events.js';
import {
  gitlabIssueChangeEvents,
  gitlabIssueChangeFromEvents,
  gitlabPluginIssueChangeEvents,
  gitlabPluginIssueChangeFromEvents,
  gitlabPluginScopeFromSource,
  gitlabPluginSource,
  isGitlabPluginId,
  issueChangeEvents,
  issueChangeFromEvents,
  parseGithubItemReference,
  parseGitlabItemReference,
  parseGitlabProjectReference,
} from '../github-item.js';
import { normalizePrTrigger } from '../pr-trigger.js';
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

  it('gives each plugin the de-duplicated event types and conditions it is watched for, nothing else', () => {
    const trigger = (sources: unknown[]) => ({ source: { preset: 'plugin', sources } }) as never;
    const project = { field: 'project', operator: 'equals' as const, value: 'group/app' };
    const iid = { field: 'iid', operator: 'equals' as const, value: '7' };
    const result = pluginEventSubscriptions([
      { status: 'active', webhookTrigger: trigger([{ plugin: 'gitlab', events: ['mr.merged', 'mr.opened'], filters: [project, iid] }]) },
      { status: 'active', webhookTrigger: trigger([{ plugin: 'gitlab', events: ['mr.opened', 'mr.merged'], filters: [iid, project] }]) },
      { status: 'active', webhookTrigger: trigger([{ plugin: 'gitlab' }, { plugin: 'chat', filters: [project] }]) },
      { status: 'paused', webhookTrigger: trigger([{ plugin: 'gitlab', events: ['issue.closed'] }]) },
    ], 100);
    expect(Object.fromEntries(result)).toEqual({
      gitlab: [{ events: ['mr.merged', 'mr.opened'], filters: [iid, project] }, {}],
      chat: [{ filters: [project] }],
    });
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

// 2026-11-24: GitLab numbers MRs (!N) and issues (#N) separately, so the one field needs a link or a sigil;
// an MR becomes a state-followed prTrigger, an issue an address-based GitLab sender narrowed to project + number.
describe('specific GitLab MR or issue', () => {
  const known = { host: 'gitlab.example.com', project: 'group/app' };
  it.each([
    ['https://gitlab.example.com/Group/Sub/App/-/merge_requests/12/diffs', undefined, { host: 'gitlab.example.com', project: 'group/sub/app', number: 12, kind: 'mr' }],
    ['https://gitlab.example.com/group/app/-/issues/3', undefined, { host: 'gitlab.example.com', project: 'group/app', number: 3, kind: 'issue' }],
    ['https://gitlab.example.com/group/app/-/work_items/3', undefined, { host: 'gitlab.example.com', project: 'group/app', number: 3, kind: 'issue' }],
    ['!12', known, { host: 'gitlab.example.com', project: 'group/app', number: 12, kind: 'mr' }],
    ['#12', known, { host: 'gitlab.example.com', project: 'group/app', number: 12, kind: 'issue' }],
    ['group/app#5', undefined, { project: 'group/app', number: 5, kind: 'issue' }],
    ['12', known, null],
    ['!12', undefined, null],
  ])('parses %s', (input, context, expected) => {
    expect(parseGitlabItemReference(input, context)).toEqual(expected);
  });

  it('saves an MR as a canonical prTrigger and an issue as a narrowed address sender', () => {
    expect(normalizePrTrigger({ url: 'https://GitLab.Example.com/Group/App/-/merge_requests/12', change: 'merged' }))
      .toEqual({ url: 'https://gitlab.example.com/group/app/-/merge_requests/12', change: 'merged' });
    expect(() => normalizePrTrigger({ url: 'https://gitlab.example.com/group/app/-/issues/12', change: 'any' })).toThrow();
    expect(normalizeScheduleWebhookSource({ preset: 'gitlab', repository: 'Group/App', number: 3 }))
      .toEqual({ preset: 'gitlab', repository: 'group/app', number: 3 });
    expect(() => normalizeScheduleWebhookSource({ preset: 'gitlab', number: 3 })).toThrow('project path');
    expect(gitlabIssueChangeFromEvents(gitlabIssueChangeEvents('closed'))).toBe('closed');
  });
});

// 测试价值
// - 生产入口与可观察结果：表单「通过 GitLab 插件」保存成插件来源、打开时还原；GitLab 插件按这些条件决定轮询哪些对象。
// - 规则依据：docs/product-rules/schedule-webhook-trigger.md（2026-11-24 GitLab 插件做事件来源）。
// - 最小失败输入：项目链接带页面路径；Agent 写的其他条件组合不能被表单改写；指定 MR 不走这条路。
// - tier：unit，纯函数。
describe('GitLab through the GitLab plugin', () => {
  it.each([
    ['group/app', { project: 'group/app' }],
    ['https://Git.Example.com/Group/Sub/App/-/merge_requests', { host: 'git.example.com', project: 'group/sub/app' }],
    ['https://git.example.com/group/app.git', { host: 'git.example.com', project: 'group/app' }],
    ['http://git.example.com/group/app', null],
    ['app', null],
    ['host:22/group/app', null],
  ])('reads project %s', (input, expected) => {
    expect(parseGitlabProjectReference(input)).toEqual(expected);
  });

  it('round-trips a whole project and a single issue, and leaves other combinations alone', () => {
    const project = { plugin: 'cindy-gitlab', host: 'git.example.com', project: 'group/app', events: ['merge_request.merged'] };
    expect(gitlabPluginScopeFromSource([gitlabPluginSource(project)])).toEqual(project);
    const issue = { plugin: 'local:cindy-gitlab', project: 'group/app', issue: 3, events: gitlabPluginIssueChangeEvents('comment') };
    const saved = gitlabPluginSource(issue);
    expect(saved.filters).toEqual([
      { field: 'project', operator: 'equals', value: 'group/app' },
      { field: 'iid', operator: 'equals', value: '3' },
      { field: 'kind', operator: 'equals', value: 'issue' },
    ]);
    expect(gitlabPluginScopeFromSource([saved])).toEqual(issue);
    expect(gitlabPluginIssueChangeFromEvents(saved.events)).toBe('comment');
    expect(gitlabPluginScopeFromSource([{ plugin: 'other-gitlab', filters: saved.filters }])).toBeNull();
    expect(gitlabPluginScopeFromSource([{ ...saved, filters: [...saved.filters, { field: 'fromSelf', operator: 'equals', value: 'false' }] }])).toBeNull();
    expect(gitlabPluginScopeFromSource([{ plugin: 'cindy-gitlab', filters: [{ field: 'project', operator: 'contains', value: 'app' }] }])).toBeNull();
    expect(gitlabPluginScopeFromSource([{ plugin: 'cindy-gitlab', filters: [
      { field: 'project', operator: 'equals', value: 'group/app' }, { field: 'iid', operator: 'equals', value: '7' },
      { field: 'kind', operator: 'equals', value: 'mr' },
    ] }])).toBeNull();
    expect(isGitlabPluginId('public/cindy-gitlab')).toBe(true);
    expect(isGitlabPluginId('_ns__local__cindy-gitlab')).toBe(true);
    expect(isGitlabPluginId('cindy-gitlab-fork')).toBe(false);
  });
});
