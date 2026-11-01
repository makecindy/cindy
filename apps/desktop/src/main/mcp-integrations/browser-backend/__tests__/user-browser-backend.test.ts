/**
 * user-browser-backend.test — 用户浏览器执行端对 BrowserControlRequest 的翻译。
 *
 * 测试价值
 * - 生产入口与可观察结果:UserBrowserBackend.call;MCP 层看到的 status / tabs / open /
 *   snapshot / act / extract 数据形状,以及不支持操作的明确拒绝。
 * - 规则依据:2026-10-27 融合决定——扩展权限不扩大、能力不足明确拒绝、不悄悄换浏览器;
 *   扩展按 URL 寻址,页面跳转须报 PAGE_CHANGED 而不是猜新页。
 * - 现有覆盖缺口:新后端。
 * - 最小失败输入:未装页面控制插件;多连接未指定 profile;标签页 URL 与记录不一致;
 *   evaluate 不带 domRead。
 * - tier:unit(假桥接);实测耗时 < 1 秒。
 */

import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest } from '@cindy/browser-control-runtime';

import {
  USER_BROWSER_CAPABILITIES,
  USER_BROWSER_PARITY_CAPABILITIES,
  UserBrowserBackend,
  extensionSupportsParity,
  userBrowserCapabilities,
  type UserBrowserPageControl,
} from '../user-browser-backend';

type Tab = { id: number; url: string; title?: string; active?: boolean; redacted?: boolean };

function fakeControl(
  options: { clients?: string[]; tabs?: Record<string, Tab[]>; version?: string } = {},
) {
  const clients = options.clients ?? ['client-aaaaaaaa'];
  const tabs = options.tabs ?? {
    [clients[0]]: [{ id: 7, url: 'https://example.test/a', title: 'A', active: true }],
  };
  const jobs: Array<[string, Record<string, unknown>]> = [];
  const responses = new Map<
    string,
    (payload: Record<string, unknown>) => Record<string, unknown>
  >();
  const bridge = {
    connectedClients: () =>
      clients.map((id) => ({
        id,
        browser: 'chrome',
        version: options.version ?? '0.4.23',
        protocolVersion: '0.4.13',
        connected: true,
      })),
    status: async () => ({
      ok: true,
      port: 18810,
      extension_ids: ['a'.repeat(32)],
      pending: 0,
      clients: clients.map((id) => ({
        id,
        browser: 'chrome',
        version: options.version ?? '0.4.23',
        protocolVersion: '0.4.13',
        connected: true,
      })),
    }),
    act: vi.fn(async (action: string, payload: Record<string, unknown>) => {
      jobs.push([action, payload]);
      const scripted = responses.get(action);
      if (scripted) return scripted(payload);
      if (action === 'tabs') return { ok: true, tabs: tabs[payload.browser as string] ?? [] };
      if (action === 'navigate') return { ok: true, url: payload.url };
      return { ok: true, url: payload.url, execution: 'executed', note: 'dispatched' };
    }),
  };
  const control: UserBrowserPageControl = {
    bridge: bridge as unknown as UserBrowserPageControl['bridge'],
    ghostId: 'my-browser',
    instanceId: 'my-browser',
    pluginName: 'Cindy Chrome',
  };
  return { control, jobs, responses, tabs };
}

function backend(
  control: UserBrowserPageControl | null,
  resolveUploadRoots?: (sessionId: string) => Promise<string[]>,
) {
  return new UserBrowserBackend({
    getPageControl: () => control,
    ...(resolveUploadRoots ? { resolveUploadRoots } : {}),
    reconnectWaitMs: 0,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

const call = (b: UserBrowserBackend, req: Record<string, unknown>) =>
  b.call(req as unknown as BrowserControlRequest);

describe('UserBrowserBackend · 就绪与连接', () => {
  it('没有页面控制插件时 status 如实报告,动作按未配置拒绝', async () => {
    const b = backend(null);
    expect(await call(b, { action: 'status' })).toMatchObject({
      ok: true,
      data: { ready: false, configured: false, backend: 'user-browser' },
    });
    expect(await call(b, { action: 'tabs' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_NOT_CONFIGURED',
    });
  });

  it('扩展未连接时 status 未就绪、start 失败;已连接时列出连接与能力表', async () => {
    const none = fakeControl({ clients: [] });
    const b = backend(none.control);
    expect(await call(b, { action: 'status' })).toMatchObject({
      ok: true,
      data: { ready: false, configured: true, connected: false },
    });
    expect(await call(b, { action: 'start' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
    const one = fakeControl();
    const ready = backend(one.control);
    expect(await call(ready, { action: 'status' })).toMatchObject({
      ok: true,
      data: {
        ready: true,
        connected: true,
        plugin: 'my-browser',
        capabilities: { evaluate: false, screenshot: false },
      },
    });
    expect(await call(ready, { action: 'doctor' })).toMatchObject({
      ok: true,
      data: { port: 18810 },
    });
    expect(await call(ready, { action: 'start', proxyServer: 'http://proxy' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(await call(ready, { action: 'profiles' })).toMatchObject({
      ok: true,
      data: { profiles: [{ id: 'client-aaaaaaaa', browser: 'chrome' }] },
    });
  });

  it('多条连接且未指定 profile 时拒绝,不猜账号;profile 前缀可定位连接', async () => {
    const two = fakeControl({
      clients: ['client-aaaaaaaa', 'client-bbbbbbbb'],
      tabs: { 'client-bbbbbbbb': [{ id: 1, url: 'https://b.test/' }] },
    });
    const b = backend(two.control);
    expect(await call(b, { action: 'open', url: 'https://b.test/' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(
      await call(b, { action: 'open', url: 'https://b.test/', profile: 'client-bbbb' }),
    ).toMatchObject({ ok: true, data: { browser: 'client-bbbbbbbb', url: 'https://b.test/' } });
  });
});

describe('UserBrowserBackend · 标签页与寻址', () => {
  it('tabs 映射稳定 targetId 与别名,保留被打码行;open 返回可用 targetId 并记住 label', async () => {
    const fake = fakeControl({
      tabs: {
        'client-aaaaaaaa': [
          { id: 7, url: 'https://example.test/a', title: 'A', active: true },
          { id: 9, url: '', redacted: true },
        ],
      },
    });
    const b = backend(fake.control);
    const listed = await call(b, { action: 'tabs' });
    expect(listed.ok).toBe(true);
    const tabs = (listed.data as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tabs[0]).toMatchObject({
      targetId: 'client-a:7',
      suggestedTargetId: 't1',
      tabId: 't1',
      url: 'https://example.test/a',
      title: 'A',
      active: true,
    });
    expect(tabs[1]).toMatchObject({ targetId: 'client-a:9', redacted: true });
    fake.tabs['client-aaaaaaaa'].push({ id: 11, url: 'https://example.test/b', title: 'B' });
    const opened = await call(b, {
      action: 'open',
      url: 'https://example.test/b',
      label: 'checkout',
    });
    expect(opened).toMatchObject({
      ok: true,
      data: {
        targetId: 'client-a:11',
        suggestedTargetId: 'checkout',
        label: 'checkout',
        url: 'https://example.test/b',
      },
    });
    expect(fake.jobs.find(([action]) => action === 'navigate')?.[1]).toMatchObject({
      url: 'https://example.test/b',
      browser: 'client-aaaaaaaa',
    });
    // navigate 可能落到另一个标签页:返回新 targetId 并标明替换。
    fake.tabs['client-aaaaaaaa'].push({ id: 12, url: 'https://example.test/c' });
    const navigated = await call(b, {
      action: 'navigate',
      targetId: 'checkout',
      url: 'https://example.test/c',
    });
    expect(navigated).toMatchObject({
      ok: true,
      data: { targetId: 'client-a:12', replacedTargetId: 'client-a:11' },
    });
  });

  it('标签页在两次调用之间跳转时报 PAGE_CHANGED 并刷新记录;关闭后提示重新选择', async () => {
    const fake = fakeControl();
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    fake.tabs['client-aaaaaaaa'][0].url = 'https://example.test/moved';
    const changed = await call(b, { action: 'snapshot', targetId: 't1' });
    expect(changed).toMatchObject({
      ok: false,
      data: { error: 'PAGE_CHANGED', url: 'https://example.test/moved' },
    });
    expect(fake.jobs.some(([action]) => action === 'snapshot')).toBe(false);
    fake.tabs['client-aaaaaaaa'] = [];
    expect(await call(b, { action: 'snapshot', targetId: 't1' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('已关闭'),
    });
    expect(await call(b, { action: 'snapshot', targetId: 'unknown' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
  });
});

describe('UserBrowserBackend · 读取与动作', () => {
  it('snapshot 把扩展的元素行转成 ref 表与可读快照', async () => {
    const fake = fakeControl();
    const ref = 'c'.repeat(32);
    fake.responses.set('snapshot', (payload) => ({
      ok: true,
      url: payload.url,
      title: 'A',
      text: 'Hello page',
      elements: `[${ref}] button Submit\n[${'d'.repeat(32)}] a`,
      truncated: false,
    }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const snap = await call(b, {
      action: 'snapshot',
      targetId: 'client-a:7',
      selector: 'main',
      maxChars: 512,
    });
    expect(snap).toMatchObject({
      ok: true,
      data: {
        format: 'ai',
        targetId: 'client-a:7',
        url: 'https://example.test/a',
        stats: { refs: 2 },
        untrusted_content: true,
      },
    });
    const snapshot = (snap.data as { snapshot: string }).snapshot;
    expect(snapshot).toContain('# A');
    expect(snapshot).toContain('Hello page');
    expect(snapshot).toContain(`- button "Submit" [ref=${ref}]`);
    expect(fake.jobs.at(-1)).toEqual([
      'snapshot',
      {
        url: 'https://example.test/a',
        browser: 'client-aaaaaaaa',
        maxChars: 512,
        selector: 'main',
      },
    ]);
    expect(snap.data).not.toHaveProperty('refs');
    // maxChars bounds the whole observation (refs first); interactive:true drops the page text.
    fake.responses.set('snapshot', () => ({ ok: true, title: 'A', text: 'x'.repeat(5000), elements: `[${ref}] button Submit` }));
    const bounded = await call(b, { action: 'snapshot', targetId: 'client-a:7', maxChars: 600 });
    expect((bounded.data as { snapshot: string }).snapshot.length).toBeLessThanOrEqual(600);
    expect(bounded.data).toMatchObject({ truncated: true });
    expect((bounded.data as { snapshot: string }).snapshot).toContain(`[ref=${ref}]`);
    const interactive = await call(b, { action: 'snapshot', targetId: 'client-a:7', interactive: true });
    expect((interactive.data as { snapshot: string }).snapshot).not.toContain('xxxx');
  });

  it('click / type / press / select / wait 翻译成扩展作业;不支持的 kind 明确拒绝', async () => {
    const fake = fakeControl();
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const base = { url: 'https://example.test/a', browser: 'client-aaaaaaaa' };
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'click', ref: 'r1' } }),
    ).toMatchObject({ ok: true, data: { kind: 'click', execution: 'executed' } });
    expect(fake.jobs.at(-1)).toEqual(['click', { ...base, ref: 'r1' }]);
    await call(b, {
      action: 'act',
      request: { kind: 'fill', targetId: 't1', selector: 'input', text: 'hi', submit: true },
    });
    expect(fake.jobs.at(-1)).toEqual([
      'type',
      { ...base, selector: 'input', text: 'hi', submit: true },
    ]);
    await call(b, { action: 'act', targetId: 't1', request: { kind: 'press', key: 'Enter' } });
    expect(fake.jobs.at(-1)).toEqual(['press', { ...base, key: 'Enter' }]);
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: { kind: 'select', selector: 'select', values: ['x'] },
    });
    expect(fake.jobs.at(-1)).toEqual(['select', { ...base, selector: 'select', values: ['x'] }]);
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: { kind: 'wait', selector: '.ready', timeoutMs: 5000 },
    });
    expect(fake.jobs.at(-1)).toEqual([
      'text',
      { ...base, selector: '.ready', waitFor: '.ready', waitMs: 5000, maxChars: 256 },
    ]);
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', timeMs: 1 } }),
    ).toMatchObject({ ok: true, data: { kind: 'wait', waitedMs: 1 } });
    // Review 2026-10-30 (Codex P2): older extensions run one wait condition per call, so a combination is refused.
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', selector: '.ready', timeMs: 500 } }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('组合') });
    // Review 2026-10-30 (Codex P2): a text wait is not something an older extension can run either.
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', selector: '.ready', text: '完成' } }),
    ).toMatchObject({ ok: false });
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', loadState: 'networkidle' } }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('networkidle') });
    // Review 2026-10-30 (Codex P2): a loadState wait on an older extension must not navigate the tab.
    fake.responses.set('tabs', () => ({ ok: true, tabs: [{ id: 7, url: 'https://example.test/a', status: 'complete' }] }));
    const navigatesBefore = fake.jobs.filter(([name]) => name === 'navigate').length;
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', loadState: 'load' } }),
    ).toMatchObject({ ok: true, data: { kind: 'wait', loadState: 'load' } });
    expect(fake.jobs.filter(([name]) => name === 'navigate').length).toBe(navigatesBefore);
    for (const request of [
      { kind: 'click', ref: 'r1', doubleClick: true },
      { kind: 'drag', startRef: 'a', endRef: 'b' },
      { kind: 'evaluate', fn: '() => 1' },
      { kind: 'wait', fn: '() => true' },
      { kind: 'click', query: { role: 'button' } },
    ]) {
      expect(await call(b, { action: 'act', targetId: 't1', request })).toMatchObject({
        ok: false,
        errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
        message: expect.stringContaining('专用浏览器'),
      });
    }
    for (const action of [
      'screenshot',
      'pdf',
      'console',
      'upload',
      'dialog',
      'requests',
      'responseBody',
      'focus',
      'close',
      'recipeCommand',
    ]) {
      expect(await call(b, { action, targetId: 't1' })).toMatchObject({
        ok: false,
        errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
      });
    }
    expect(
      fake.jobs.filter(
        ([action]) => !['tabs', 'click', 'type', 'press', 'select', 'text'].includes(action),
      ),
    ).toEqual([]);
  });

  it('声明式读取走扩展 extract:字段映射、结果包装;登录墙检测如实报告不可用', async () => {
    const fake = fakeControl();
    fake.responses.set('extract', (payload) => ({
      ok: true,
      url: payload.url,
      count: 1,
      records: [{ title: 'T', link: 'https://example.test/x' }],
      truncated: false,
    }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const extracted = await call(b, {
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        fn: 'ignored',
        domRead: {
          kind: 'extract',
          extract: {
            from: '.row',
            multiple: true,
            limit: 5,
            fields: { title: 'h3', link: { selector: 'a', type: 'href' }, self: { attr: 'title' } },
          },
        },
      },
    });
    expect(extracted).toMatchObject({
      ok: true,
      data: { result: { ok: true, count: 1, records: [{ title: 'T' }] }, untrusted_content: true },
    });
    expect(fake.jobs.at(-1)).toEqual([
      'extract',
      {
        url: 'https://example.test/a',
        browser: 'client-aaaaaaaa',
        fields: {
          title: 'h3',
          link: { selector: 'a', attr: 'href' },
          self: { selector: ':self', attr: 'title' },
        },
        from: '.row',
        multiple: true,
        limit: 5,
        maxChars: 6000,
      },
    ]);
    // Bug regression: a whole-page read (`body` / `:scope`, no `from`) came back
    // null because the extension resolves fields against document.body and only
    // knows ':self'; a single-record `from` was ignored for the same reason.
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        fn: 'ignored',
        domRead: {
          kind: 'extract',
          extract: { fields: { page: 'body', self: { selector: ':scope' }, rows: 'tr' } },
        },
      },
    });
    expect(fake.jobs.at(-1)?.[1]).toMatchObject({
      fields: { page: ':self', self: { selector: ':self' }, rows: 'tr' },
    });
    expect(fake.jobs.at(-1)?.[1]).not.toHaveProperty('from');
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        fn: 'ignored',
        domRead: { kind: 'extract', extract: { from: 'main', fields: { text: {} } } },
      },
    });
    expect(fake.jobs.at(-1)?.[1]).toMatchObject({
      selector: 'main',
      fields: { text: { selector: ':self' } },
    });
    expect(fake.jobs.at(-1)?.[1]).not.toHaveProperty('from');
    expect(
      await call(b, {
        action: 'act',
        targetId: 't1',
        request: {
          kind: 'evaluate',
          fn: 'x',
          domRead: { kind: 'extract', extract: { fields: { body: { type: 'html' } } } },
        },
      }),
    ).toMatchObject({ ok: false, errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST' });
    const wall = await call(b, {
      action: 'act',
      targetId: 't1',
      request: { kind: 'evaluate', fn: 'x', domRead: { kind: 'login-wall' } },
    });
    expect(wall).toMatchObject({
      ok: true,
      data: { result: { password: false, code: false, unavailable: true } },
    });
    expect(
      fake.jobs.filter(
        ([action, payload]) =>
          action === 'extract' && (payload.fields as Record<string, unknown>).password,
      ),
    ).toEqual([]);
  });

  it('能力表按扩展版本给出:0.4.43 起完整,旧版只有基础能力', () => {
    expect(extensionSupportsParity('0.4.43')).toBe(true);
    expect(extensionSupportsParity('0.5.0')).toBe(true);
    expect(extensionSupportsParity('0.4.42')).toBe(false);
    expect(extensionSupportsParity(null)).toBe(false);
    expect(userBrowserCapabilities(fakeControl().control)).toBe(USER_BROWSER_CAPABILITIES);
    expect(userBrowserCapabilities(fakeControl({ version: '0.4.43' }).control)).toBe(
      USER_BROWSER_PARITY_CAPABILITIES,
    );
    // Not connected (reloading, reconnecting) means unknown, not "old": the backend reports the
    // disconnect per job instead of the tool layer refusing screenshots with a misleading hint.
    expect(userBrowserCapabilities(null)).toBe(USER_BROWSER_PARITY_CAPABILITIES);
    expect(userBrowserCapabilities(fakeControl({ clients: [] }).control)).toBe(
      USER_BROWSER_PARITY_CAPABILITIES,
    );
  });

  it('新版扩展:open 开到后台窗口并按 tabId 寻址,不再逐次列标签页', async () => {
    const fake = fakeControl({ version: '0.4.43' });
    fake.responses.set('open', (payload) => ({
      ok: true,
      tabId: 42,
      window: 500,
      url: payload.url,
      title: 'New',
    }));
    const b = backend(fake.control);
    const opened = await call(b, { action: 'open', url: 'https://example.test/new', label: 'n' });
    expect(opened).toMatchObject({ ok: true, data: { suggestedTargetId: 'n', title: 'New' } });
    expect(fake.jobs.at(-1)).toEqual([
      'open',
      { url: 'https://example.test/new', browser: 'client-aaaaaaaa' },
    ]);
    await call(b, { action: 'act', targetId: 'n', request: { kind: 'click', ref: 'r1' } });
    expect(fake.jobs.at(-1)).toEqual([
      'click',
      { url: 'https://example.test/new', browser: 'client-aaaaaaaa', tabId: 42, ref: 'r1' },
    ]);
    await call(b, { action: 'navigate', targetId: 'n', url: 'https://example.test/next' });
    expect(fake.jobs.at(-1)).toEqual([
      'navigate',
      { url: 'https://example.test/next', browser: 'client-aaaaaaaa', tabId: 42 },
    ]);
    expect(fake.jobs.filter(([action]) => action === 'tabs')).toEqual([]);
  });

  it('新版扩展:截图、控制台、网络、弹窗、切换与关闭映射成标签页作业', async () => {
    const fake = fakeControl({ version: '0.4.43' });
    fake.responses.set('screenshot', () => ({
      ok: true,
      tabId: 7,
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
      bytes: 8,
      note: 'Only the visible area was captured.',
    }));
    fake.responses.set('console', () => ({ ok: true, messages: [{ level: 'log', text: 'x' }] }));
    fake.responses.set('requests', () => ({ ok: true, requests: [{ url: 'https://example.test/api' }] }));
    fake.responses.set('responseBody', () => ({ ok: true, response: { status: 200, body: '{}' } }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const base = { url: 'https://example.test/a', browser: 'client-aaaaaaaa', tabId: 7 };
    expect(await call(b, { action: 'screenshot', targetId: 't1', fullPage: true })).toMatchObject({
      ok: true,
      data: { mimeType: 'image/png', data: 'iVBORw0KGgo=', note: expect.stringContaining('visible area') },
    });
    expect(fake.jobs.at(-1)).toEqual(['screenshot', { ...base, type: 'png', fullPage: true }]);
    expect(await call(b, { action: 'console', targetId: 't1' })).toMatchObject({
      data: { messages: [{ level: 'log', text: 'x' }] },
    });
    await call(b, { action: 'requests', targetId: 't1', filter: 'api', clear: true });
    expect(fake.jobs.at(-1)).toEqual(['requests', { ...base, filter: 'api', clear: true }]);
    expect(
      await call(b, { action: 'responseBody', targetId: 't1', url: 'https://example.test/api' }),
    ).toMatchObject({ data: { response: { status: 200 } } });
    expect(fake.jobs.at(-1)).toEqual([
      'responseBody',
      { ...base, requestUrl: 'https://example.test/api' },
    ]);
    await call(b, { action: 'dialog', targetId: 't1', accept: true, promptText: 'y' });
    expect(fake.jobs.at(-1)).toEqual(['dialog', { ...base, accept: true, promptText: 'y' }]);
    await call(b, { action: 'focus', targetId: 't1' });
    expect(fake.jobs.at(-1)).toEqual(['focus', base]);
    expect(await call(b, { action: 'close', targetId: 't1' })).toMatchObject({ ok: true });
    expect(await call(b, { action: 'snapshot', targetId: 't1' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('未知 targetId'),
    });
    expect(await call(b, { action: 'pdf', targetId: 't1' })).toMatchObject({ ok: false });
  });

  it('新版扩展:脚本、坐标、拖拽、调整大小、双击与等待都交给扩展', async () => {
    const fake = fakeControl({ version: '0.4.43' });
    let polls = 0;
    fake.responses.set('evaluate', (payload) =>
      payload.fn === '() => ready'
        ? { ok: true, result: ++polls >= 2 }
        : { ok: true, result: { title: 'A' } },
    );
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const base = { url: 'https://example.test/a', browser: 'client-aaaaaaaa', tabId: 7 };
    const act = (request: Record<string, unknown>) =>
      call(b, { action: 'act', targetId: 't1', request });
    expect(await act({ kind: 'evaluate', fn: '() => ({title: document.title})' })).toMatchObject({
      ok: true,
      data: { result: { title: 'A' } },
    });
    await act({ kind: 'clickCoords', x: 10, y: 20, button: 'right' });
    expect(fake.jobs.at(-1)).toEqual(['clickCoords', { ...base, x: 10, y: 20, button: 'right' }]);
    await act({ kind: 'click', ref: 'r1', doubleClick: true, modifiers: ['Shift'] });
    expect(fake.jobs.at(-1)).toEqual([
      'clickCoords',
      { ...base, ref: 'r1', doubleClick: true, modifiers: ['Shift'] },
    ]);
    await act({ kind: 'drag', startRef: 'a', endRef: 'b' });
    expect(fake.jobs.at(-1)).toEqual(['drag', { ...base, startRef: 'a', endRef: 'b' }]);
    await act({ kind: 'resize', width: 800, height: 600 });
    expect(fake.jobs.at(-1)).toEqual(['resize', { ...base, width: 800, height: 600 }]);
    await act({ kind: 'wait', textGone: 'Loading', url: '/done', timeoutMs: 5000 });
    expect(fake.jobs.at(-1)).toEqual([
      'wait',
      { ...base, textGone: 'Loading', urlIncludes: '/done', timeoutMs: 5000 },
    ]);
    expect(await act({ kind: 'wait', fn: '() => ready', timeoutMs: 5000 })).toMatchObject({
      ok: true,
      data: { kind: 'wait', result: true },
    });
    expect(polls).toBe(2);
    expect(await act({ kind: 'evaluate', domRead: { kind: 'login-wall' } })).toMatchObject({
      ok: true,
    });
    expect(fake.jobs.at(-1)?.[0]).toBe('evaluate');
  });

  it('新版扩展:上传只读会话允许目录里的文件,并以字节交给扩展', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const root = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'cindy-upload-'));
    try {
      const file = pathMod.join(root, 'a.png');
      await fsp.writeFile(file, Buffer.from([1, 2, 3]));
      const fake = fakeControl({ version: '0.4.43' });
      fake.responses.set('upload', () => ({ ok: true, files: [{ name: 'a.png', size: 3 }] }));
      const b = backend(fake.control, async () => [root]);
      await call(b, { action: 'tabs' });
      expect(
        await call(b, {
          action: 'upload',
          targetId: 't1',
          paths: [file],
          inputRef: 'r9',
          __mcpSessionId: 's1',
        }),
      ).toMatchObject({ ok: true, data: { files: [{ name: 'a.png', size: 3 }] } });
      expect(fake.jobs.at(-1)?.[1]).toMatchObject({
        tabId: 7,
        ref: 'r9',
        files: [{ name: 'a.png', data: 'AQID', mimeType: 'image/png' }],
      });
      // Review 2026-10-29: a batch over the extension's ~30 MB limit is refused before any file is read.
      const big = pathMod.join(root, 'big.bin');
      const bigBytes = Buffer.alloc(9_000_000, 7);
      await fsp.writeFile(big, '');
      await fsp.truncate(big, 31_000_000);
      const jobsBefore = fake.jobs.length;
      expect(
        await call(b, { action: 'upload', targetId: 't1', paths: [big], __mcpSessionId: 's1' }),
      ).toMatchObject({ ok: false, message: expect.stringContaining('30 MB') });
      expect(fake.jobs.length).toBe(jobsBefore);
      // 2026-11-01: from 0.4.61 larger files go in pieces; Chrome's debugger is never needed.
      await fsp.writeFile(big, bigBytes);
      await fsp.appendFile(big, Buffer.alloc(22_000_000, 8));
      const newer = fakeControl({ version: '0.4.61' });
      newer.responses.set('upload', (payload) =>
        payload.op === 'finish' ? { ok: true, files: [{ name: 'big.bin', size: 31_000_000 }] } : { ok: true });
      const nb = backend(newer.control, async () => [root]);
      await call(nb, { action: 'tabs' });
      expect(await call(nb, { action: 'upload', targetId: 't1', paths: [big], inputRef: 'r9', __mcpSessionId: 's1' })).toMatchObject({
        ok: true,
        data: { files: [{ name: 'big.bin', size: 31_000_000 }] },
      });
      const steps = newer.jobs.filter(([kind]) => kind === 'upload').map(([, payload]) => payload);
      expect(steps[0]).toMatchObject({ op: 'begin', ref: 'r9', chunkFiles: [{ name: 'big.bin' }] });
      expect(steps.at(-1)).toMatchObject({ op: 'finish' });
      const pieces = steps.filter((step) => step.op === 'chunk');
      expect(pieces.length).toBe(8);
      expect(new Set(steps.map((step) => step.transfer)).size).toBe(1);
      expect(steps.some((step) => 'paths' in step)).toBe(false);
      const rebuilt = Buffer.concat(pieces.map((step) => Buffer.from(step.data as string, 'base64')));
      expect(rebuilt.length).toBe(31_000_000);
      expect(rebuilt.equals(await fsp.readFile(big))).toBe(true);
      // Small files still fit one job, without any path.
      await call(nb, { action: 'upload', targetId: 't1', paths: [file], __mcpSessionId: 's1' });
      expect(newer.jobs.at(-1)?.[1]).toMatchObject({ files: [{ name: 'a.png', data: 'AQID' }] });
      expect(newer.jobs.at(-1)?.[1]).not.toHaveProperty('paths');
      // A piece the page refuses ends the transfer: the input stays as it was and memory is released.
      const failing = fakeControl({ version: '0.4.61' });
      failing.responses.set('upload', (payload) =>
        payload.op === 'chunk' ? { ok: false, error: 'UPLOAD_EXPIRED', message: 'page changed' } : { ok: true });
      const fb = backend(failing.control, async () => [root]);
      await call(fb, { action: 'tabs' });
      expect(await call(fb, { action: 'upload', targetId: 't1', paths: [big], __mcpSessionId: 's1' })).toMatchObject({
        ok: false,
        message: expect.stringContaining('UPLOAD_EXPIRED'),
      });
      await vi.waitFor(() => expect(failing.jobs.at(-1)?.[1]).toMatchObject({ op: 'abort' }));
      expect(failing.jobs.some(([, payload]) => payload.op === 'finish')).toBe(false);
      // A file over the 1 GB bound is refused before any file is read.
      const huge = pathMod.join(root, 'huge.bin');
      await fsp.writeFile(huge, '');
      await fsp.truncate(huge, 1024 * 1024 * 1024 + 1);
      const beforeHuge = newer.jobs.length;
      expect(await call(nb, { action: 'upload', targetId: 't1', paths: [huge], __mcpSessionId: 's1' })).toMatchObject({ ok: false });
      expect(newer.jobs.length).toBe(beforeHuge);
      expect(
        await call(b, {
          action: 'upload',
          targetId: 't1',
          paths: ['/etc/hosts'],
          __mcpSessionId: 's1',
        }),
      ).toMatchObject({ ok: false });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // Review 2026-10-30 (Codex P2): navigating an explicit targetId that no longer resolves must fail.
  it('navigate 的显式 targetId 解析不了时报错,不新开页面', async () => {
    const fake = fakeControl({ version: '0.4.56', tabs: { 'client-aaaaaaaa': [{ id: 1, url: 'https://a.test/' }] } });
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const jobsBefore = fake.jobs.length;
    expect(await call(b, { action: 'navigate', targetId: 'gone-tab', url: 'https://b.test/' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('已不存在'),
    });
    expect(fake.jobs.length).toBe(jobsBefore);
  });

  // Review 2026-10-30 (Codex P2): fn gets its own full wait after the earlier conditions used up time.
  it('wait 的 fn 在前置条件耗时之后重新计时', async () => {
    let clock = 0;
    const fake = fakeControl({ version: '0.4.56' });
    let evaluations = 0;
    fake.responses.set('wait', () => {
      clock += 5000;
      return { ok: true };
    });
    fake.responses.set('evaluate', () => ({ ok: true, result: ++evaluations >= 2 }));
    const b = new UserBrowserBackend({
      getPageControl: () => fake.control,
      reconnectWaitMs: 0,
      now: () => clock,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as ConstructorParameters<typeof UserBrowserBackend>[0]);
    await call(b, { action: 'tabs' });
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', selector: '#x', fn: '() => ready', timeoutMs: 1000 } }),
    ).toMatchObject({ ok: true, data: { kind: 'wait', result: true } });
    expect(evaluations).toBe(2);
  });

  // Review 2026-10-30 (Codex P2): connections whose ids share a prefix must not share targetIds.
  it('前缀相同的两个连接各有自己的 targetId', async () => {
    const fake = fakeControl({
      version: '0.3.9',
      clients: ['abcdefgh-1111', 'abcdefgh-2222'],
      tabs: {
        'abcdefgh-1111': [{ id: 1, url: 'https://a.test/' }],
        'abcdefgh-2222': [{ id: 1, url: 'https://b.test/' }],
      },
    });
    const b = backend(fake.control);
    const listed = (await call(b, { action: 'tabs' })) as { data?: { tabs?: Array<{ targetId?: string; url?: string }> } };
    const tabs = listed.data?.tabs ?? [];
    expect(tabs).toHaveLength(2);
    expect(new Set(tabs.map((t) => t.targetId)).size).toBe(2);
  });

  // Review 2026-10-30 (Codex P1): every action that names a tab refuses a profile of another connection.
  it('act 的 targetId 与 profile 不属于同一连接时拒绝', async () => {
    const fake = fakeControl({
      version: '0.4.56',
      clients: ['client-aaaaaaaa', 'client-bbbbbbbb'],
      tabs: { 'client-aaaaaaaa': [{ id: 1, url: 'https://a.test/' }], 'client-bbbbbbbb': [] },
    });
    const b = backend(fake.control);
    const listed = (await call(b, { action: 'tabs', profile: 'client-aaaaaaaa' })) as {
      data?: { tabs?: Array<{ targetId?: string }> };
    };
    const targetId = listed.data?.tabs?.[0]?.targetId;
    const jobsBefore = fake.jobs.length;
    expect(
      await call(b, { action: 'act', targetId, profile: 'client-bbbbbbbb', request: { kind: 'click', ref: 'r1' } }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('不一致') });
    expect(await call(b, { action: 'snapshot', targetId, profile: 'client-bbbbbbbb' })).toMatchObject({ ok: false });
    expect(fake.jobs.length).toBe(jobsBefore);
    // The matching profile (or none) still works.
    expect(
      await call(b, { action: 'act', targetId, profile: 'client-aaaa', request: { kind: 'click', ref: 'r1' } }),
    ).toMatchObject({ ok: true });
  });

  // Review 2026-10-30 (Codex P1): a profile that disagrees with the tab's own connection must be refused.
  it('navigate 的 targetId 与 profile 属于不同连接时拒绝', async () => {
    const fake = fakeControl({
      version: '0.4.56',
      clients: ['client-aaaaaaaa', 'client-bbbbbbbb'],
      tabs: { 'client-aaaaaaaa': [{ id: 1, url: 'https://a.test/' }], 'client-bbbbbbbb': [] },
    });
    const b = backend(fake.control);
    const listed = (await call(b, { action: 'tabs', profile: 'client-aaaaaaaa' })) as {
      data?: { tabs?: Array<{ targetId?: string }> };
    };
    const targetId = listed.data?.tabs?.[0]?.targetId;
    expect(targetId).toBeTruthy();
    const jobsBefore = fake.jobs.length;
    expect(
      await call(b, { action: 'navigate', targetId, profile: 'client-bbbbbbbb', url: 'https://c.test/' }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('不一致') });
    expect(fake.jobs.length).toBe(jobsBefore);
  });

  // Review 2026-10-30 (Codex P1): an abbreviated profile that matches two connections must not pick one.
  it('缩写的 profile 匹配多个连接时拒绝,精确 id 优先', async () => {
    const fake = fakeControl({
      clients: ['client-aaaa1111', 'client-aaaa2222', 'client-aaaa'],
      tabs: { 'client-aaaa': [{ id: 1, url: 'https://b.test/' }] },
    });
    const b = backend(fake.control);
    expect(await call(b, { action: 'open', url: 'https://b.test/', profile: 'client-aaa' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('匹配多个'),
    });
    expect(await call(b, { action: 'tabs', profile: 'nope' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
      message: expect.stringContaining('未找到'),
    });
    expect(await call(b, { action: 'tabs', profile: 'client-aaa' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('匹配多个'),
    });
    expect(await call(b, { action: 'open', url: 'https://b.test/', profile: 'client-aaaa' })).toMatchObject({
      ok: true,
      data: { browser: 'client-aaaa' },
    });
  });

  it('快照:limit 传给扩展,新版扩展接受 frame,截断时说明后面还有内容', async () => {
    const fake = fakeControl({ version: '0.4.61' });
    fake.responses.set('snapshot', () => ({ ok: true, title: 'T', text: 'x', elements: '', truncated: true }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const result = await call(b, { action: 'snapshot', targetId: 't1', limit: 200, frame: 'iframe' });
    expect(fake.jobs.at(-1)?.[1]).toMatchObject({ limit: 200 });
    expect(result).toMatchObject({ ok: true, data: { truncated: true } });
    const data = result.data as { note?: string; frameNote?: string };
    expect(data.note).toContain('selector');
    expect(data.frameNote).toContain('iframe');
    const older = fakeControl({ version: '0.4.60' });
    const ob = backend(older.control);
    await call(ob, { action: 'tabs' });
    expect(await call(ob, { action: 'snapshot', targetId: 't1', frame: 'iframe' })).toMatchObject({ ok: false });
  });

  it('调试接口:Chrome 不允许按需申请,能力表如实报告,扩展拒绝时不让用户去找开启入口', async () => {
    const fake = fakeControl({ version: '0.4.61' });
    expect(userBrowserCapabilities(fake.control)).toMatchObject({ pdf: false, rawProtocol: false, upload: true });
    for (const error of ['DEBUGGER_NOT_ALLOWED', 'DEBUGGER_UNAVAILABLE']) {
      fake.responses.set('pdf', () => ({ ok: false, error, message: 'needs debugger', grantPageOpened: true }));
      const b = backend(fake.control);
      await call(b, { action: 'tabs' });
      const refused = await call(b, { action: 'pdf', targetId: 't1' });
      expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('Cindy 专用浏览器') });
      expect(refused.message).not.toContain('开启」');
    }
  });

  it('配方协议会话:按需接上调试,事件随结果回传,结束即断开', async () => {
    const fake = fakeControl({ version: '0.4.43' });
    fake.responses.set('cdp', (payload) => {
      if (payload.op === 'command' && payload.method === 'Network.getCookies')
        return { ok: true, result: { cookies: [{ name: 'sid' }] }, events: [] };
      if (payload.op === 'command')
        return {
          ok: true,
          result: {},
          events: [
            ['Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.test/api', method: 'GET' } }],
            ['Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: {} } }],
          ],
        };
      if (payload.op === 'events')
        return { ok: true, events: [['Network.loadingFailed', { requestId: 'r1' }]] };
      return { ok: true };
    });
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const scope = { targetId: 't1', __mcpSessionId: 's1' };
    const begun = await call(b, { action: 'recipeCommand', ...scope, recipeCommand: { method: 'Cindy.begin' } });
    const sessionId = (begun.data as { sessionId: string }).sessionId;
    expect(fake.jobs.at(-1)).toEqual([
      'cdp',
      { url: 'https://example.test/a', browser: 'client-aaaaaaaa', tabId: 7, op: 'begin' },
    ]);
    await call(b, { action: 'recipeCommand', ...scope, recipeCommand: { method: 'Cindy.captureStart', sessionId, params: { pattern: '/api' } } });
    expect(
      await call(b, { action: 'recipeCommand', ...scope, recipeCommand: { method: 'Network.getCookies', sessionId, params: {} } }),
    ).toMatchObject({ ok: true, data: { cookies: [{ name: 'sid' }] } });
    const read = await call(b, { action: 'recipeCommand', ...scope, recipeCommand: { method: 'Cindy.captureRead', sessionId } });
    expect(read).toMatchObject({
      ok: true,
      data: { entries: [{ url: 'https://example.test/api', responseStatus: 200, captureComplete: true }] },
    });
    await call(b, { action: 'recipeCommand', ...scope, recipeCommand: { method: 'Cindy.end', sessionId } });
    expect(fake.jobs.at(-1)).toEqual([
      'cdp',
      { url: 'https://example.test/a', browser: 'client-aaaaaaaa', tabId: 7, op: 'end' },
    ]);
  });

  it('任务停下时清掉它操作过的页面上的标记', async () => {
    const fake = fakeControl({ version: '0.4.43' });
    fake.responses.set('open', (payload) => ({ ok: true, tabId: 42, url: payload.url, title: 'New' }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs', __mcpSessionId: 's1' });
    expect(await call(b, { action: 'open', url: 'https://example.test/other', __mcpSessionId: 's1' })).toMatchObject({ ok: true });
    await call(b, { action: 'act', targetId: 't1', request: { kind: 'click', ref: 'r' }, __mcpSessionId: 's1' });
    await b.clearSessionMarks('s1');
    const unmarked = fake.jobs.filter(([action]) => action === 'unmark').map(([, payload]) => payload.tabId as number).sort((x, y) => x - y);
    expect(unmarked).toEqual([7, 42]);
    await b.clearSessionMarks('s1');
    expect(fake.jobs.filter(([action]) => action === 'unmark')).toHaveLength(2);
  });

  it('focus 只在 Cindy 窗口内切页并提醒,提示模型请用户切过去完成', async () => {
    const fake = fakeControl({ version: '0.4.43' });
    fake.responses.set('focus', () => ({ ok: true, handoff: true }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    expect(await call(b, { action: 'focus', targetId: 't1' })).toMatchObject({
      ok: true,
      data: { note: expect.stringContaining('不抢焦点') },
    });
  });

  it('status 先等扩展重连几秒,不在刷新后的空档里报未连接', async () => {
    const fake = fakeControl({ version: '0.4.46' });
    let calls = 0;
    const realStatus = (fake.control.bridge as unknown as { status: () => Promise<{ ok: boolean; clients: Array<{ connected: boolean }> }> }).status;
    (fake.control.bridge as unknown as { status: () => Promise<unknown> }).status = async () => {
      const s = await realStatus();
      // Connected first, then dropped for two reads (an extension reload), then back.
      ++calls;
      return calls === 2 || calls === 3 ? { ...s, clients: s.clients.map((c) => ({ ...c, connected: false })) } : s;
    };
    const b = new UserBrowserBackend({ getPageControl: () => fake.control, reconnectWaitMs: 5000, logger: { info: vi.fn(), warn: vi.fn() } });
    expect(await call(b, { action: 'status' })).toMatchObject({ ok: true, data: { connected: true } });
    expect(await call(b, { action: 'status' })).toMatchObject({ ok: true, data: { connected: true } });
    expect(calls).toBe(4);
  });

  // Review 2026-10-29: an installed but unpaired extension waited 8 s and was then told to install
  // the extension; it must be reported at once with its real reason.
  // Review 2026-10-29 (Greptile P1): {kind:'wait', timeMs, text} was treated as a pure sleep and
  // returned success without ever checking that the text appeared.
  it('带文字条件的等待交给页面检查,不当作纯睡眠', async () => {
    const fake = fakeControl({ version: '0.4.46' });
    fake.responses.set('open', (payload) => ({ ok: true, tabId: 42, window: 500, url: payload.url, title: 'T' }));
    fake.responses.set('wait', () => ({ ok: true, execution: 'executed' }));
    const b = backend(fake.control);
    await call(b, { action: 'open', url: 'https://example.test/new', label: 'n' });
    const started = Date.now();
    await call(b, { action: 'act', targetId: 'n', request: { kind: 'wait', timeMs: 20000, text: '上传完成' } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fake.jobs.at(-1)).toMatchObject(['wait', { text: '上传完成', tabId: 42 }]);
  });

  // Review 2026-10-29: with many tabs the list is cut at its limit, and the handle of a tab the
  // agent had just opened vanished because it was not in the truncated list.
  it('标签页列表被截断时不丢掉没列出来的已记住标签', async () => {
    const fake = fakeControl({ version: '0.4.46' });
    fake.responses.set('open', (payload) => ({ ok: true, tabId: 42, window: 500, url: payload.url, title: 'New' }));
    const b = backend(fake.control);
    await call(b, { action: 'open', url: 'https://example.test/new', label: 'n' });
    fake.responses.set('tabs', () => ({
      ok: true,
      tabs: [{ id: 7, url: 'https://example.test/a', title: 'A', active: true }],
      truncated: true,
    }));
    await call(b, { action: 'tabs' });
    await call(b, { action: 'act', targetId: 'n', request: { kind: 'click', ref: 'r1' } });
    expect(fake.jobs.at(-1)).toMatchObject(['click', { tabId: 42 }]);
  });

  // Review 2026-10-29: tab ids start over after a browser restart while the client id stays, so a
  // remembered handle could act on a tab the user restored.
  it('浏览器重启(启动 id 变化)后忘掉之前记住的标签页', async () => {
    const fake = fakeControl({ version: '0.4.46' });
    let boot = '11111111-1111-1111-1111-111111111111';
    const connected = fake.control.bridge.connectedClients.bind(fake.control.bridge);
    (fake.control.bridge as unknown as { connectedClients: () => unknown[] }).connectedClients = () =>
      connected().map((c) => ({ ...c, boot }));
    fake.responses.set('open', (payload) => ({ ok: true, tabId: 42, window: 500, url: payload.url, title: 'New' }));
    const b = backend(fake.control);
    const opened = await call(b, { action: 'open', url: 'https://example.test/new', label: 'n' });
    const oldTarget = (opened.data as { targetId: string }).targetId;
    boot = '22222222-2222-2222-2222-222222222222';
    const before = fake.jobs.length;
    const result = await call(b, { action: 'act', targetId: 'n', request: { kind: 'click', ref: 'r1' } });
    expect(result.ok).toBe(false);
    expect(fake.jobs.slice(before).some(([action]) => action === 'click')).toBe(false);
    // A restored tab with the same number gets a new handle; the old full id stays unknown.
    fake.responses.set('tabs', () => ({ ok: true, tabs: [{ id: 42, url: 'https://example.test/restored', title: 'R' }] }));
    const listed = await call(b, { action: 'tabs' });
    const relisted = (listed.data as { tabs: Array<{ targetId: string }> }).tabs[0].targetId;
    expect(relisted).not.toBe(oldTarget);
    expect((await call(b, { action: 'act', targetId: oldTarget, request: { kind: 'click', ref: 'r1' } })).ok).toBe(false);
  });

  it('扩展已连上但没配对时 status 立即说明需要配对,不空等', async () => {
    const fake = fakeControl({ version: '0.4.46' });
    const realStatus = (fake.control.bridge as unknown as { status: () => Promise<{ ok: boolean; clients: Array<Record<string, unknown>> }> }).status;
    (fake.control.bridge as unknown as { status: () => Promise<unknown> }).status = async () => {
      const s = await realStatus();
      return { ...s, clients: s.clients.map((c) => ({ ...c, connected: false, trusted: false })) };
    };
    (fake.control.bridge as unknown as { connectedClients: () => unknown[] }).connectedClients = () => [];
    const b = new UserBrowserBackend({ getPageControl: () => fake.control, reconnectWaitMs: 60_000, logger: { info: vi.fn(), warn: vi.fn() } });
    const started = Date.now();
    expect(await call(b, { action: 'status' })).toMatchObject({
      ok: true,
      data: { connected: false, reason: 'pairing-required' },
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('从没连过扩展时 status 立即报告未连接,不空等', async () => {
    const fake = fakeControl({ clients: [] });
    const b = new UserBrowserBackend({ getPageControl: () => fake.control, reconnectWaitMs: 60_000, logger: { info: vi.fn(), warn: vi.fn() } });
    const started = Date.now();
    expect(await call(b, { action: 'status' })).toMatchObject({ ok: true, data: { connected: false } });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
