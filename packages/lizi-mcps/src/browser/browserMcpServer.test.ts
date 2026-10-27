import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';
import { describe, expect, it } from 'vitest';

import { createBrowserMcpServer } from './server.js';
import { INLINE_IMAGE_TARGET_BYTES, type BrowserMcpDeps } from '../types.js';

// `respond` lets a test script the result per call (e.g. a navigate that returns
// a swapped targetId); default echoes the request back as data.
function makeRuntime(
  respond?: (request: { action: string; [k: string]: unknown }, i: number) => Record<string, unknown> | undefined,
): { runtime: BrowserControlRuntime; calls: unknown[] } {
  const calls: unknown[] = [];
  const runtime: BrowserControlRuntime = {
    async call(request) {
      const i = calls.length;
      calls.push(request);
      const scripted = respond?.(request as { action: string }, i);
      return { ok: true, action: request.action, data: scripted ?? { received: request } };
    },
  };
  return { runtime, calls };
}

async function makeHarness(
  extraDeps?: Partial<BrowserMcpDeps>,
  respond?: (request: { action: string; [k: string]: unknown }, i: number) => Record<string, unknown> | undefined,
) {
  const { runtime, calls } = makeRuntime(respond);
  const server = createBrowserMcpServer({ getRuntime: () => runtime, ...extraDeps });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-smoke-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    calls,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('createBrowserMcpServer', () => {
  // Historical form replay spent a second model call on every post-click read.
  // Unit tier, production MCP entry: preserve successful mutations on read errors,
  // select the returned tab, and retain the existing password-handoff behavior.
  it.each([{}, { selector: '#form', maxChars: 1000 }])('returns an opt-in post-action snapshot on the actual resulting tab: %j', async (afterSnapshot) => {
    const h = await makeHarness({}, (request) => request.action === 'snapshot'
      ? { targetId: 'new-tab', snapshot: '- button "Continue" [ref=e1]' }
      : request.request && (request.request as { kind: string }).kind === 'evaluate'
        ? { result: { password: true } }
        : { targetId: 'new-tab' });
    try {
      const response = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: {
        action: 'act', targetId: 'old-tab', request: { kind: 'click', ref: 'e2' }, afterSnapshot,
      } } });
      expect(response.isError).toBe(false);
      expect(JSON.parse((response.content as Array<{ text: string }>)[0].text)).toMatchObject({
        ok: true, data: { targetId: 'new-tab' }, afterSnapshot: {
          ok: true, data: { snapshot: '- button "Continue" [ref=e1]' }, loginWall: { fields: ['password'] },
        },
      });
      expect(h.calls[0]).not.toHaveProperty('afterSnapshot');
      expect(h.calls[1]).toMatchObject({
        action: 'snapshot', targetId: 'new-tab', compact: true,
        refs: 'selector' in afterSnapshot ? 'role' : 'aria', maxChars: 'maxChars' in afterSnapshot ? 1000 : 4000,
      });
    } finally { await h.cleanup(); }
  });

  // Live Google Play role snapshots exceeded maxChars. Verify the production
  // MCP response bounds text and removes hidden refs, while preserving success.
  it.each([undefined, 64])('bounds post-action snapshots even when the runtime ignores maxChars (%s)', async (maxChars) => {
    const visible = '- button "Continue" [ref=e1]';
    const h = await makeHarness({}, (request) => request.action === 'snapshot'
      ? { snapshot: `${visible}\n${'x'.repeat(5000)}\n- button "Hidden" [ref=e2]`, refs: { e1: { role: 'button', name: 'Continue' }, e2: { role: 'button', name: 'Hidden' } }, stats: { chars: 5100 } }
      : { targetId: 'tab' });
    try {
      const response = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: {
        action: 'act', targetId: 'tab', request: { kind: 'click', ref: 'e1' }, afterSnapshot: { selector: '#main-content', ...(maxChars ? { maxChars } : {}) },
      } } });
      const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
      expect(response.isError).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.afterSnapshot.data.snapshot).toBe(visible);
      expect(result.afterSnapshot.data.snapshot.length).toBeLessThanOrEqual(maxChars ?? 4000);
      expect(Object.keys(result.afterSnapshot.data.refs)).toEqual(['e1']);
      expect(result.afterSnapshot.data.truncated).toBe(true);
      expect(result.afterSnapshot.data.stats).toBeUndefined();
    } finally { await h.cleanup(); }
  });

  it.each(['throw', 'error'] as const)('preserves a successful upload when the subsequent snapshot fails (%s)', async (failure) => {
    let uploads = 0;
    const runtime: BrowserControlRuntime = { async call(req) {
      if (req.action === 'snapshot') {
        if (failure === 'throw') throw new Error('page closed');
        return { ok: false, action: req.action, message: 'page closed' };
      }
      uploads++;
      return { ok: true, action: req.action, data: { targetId: 'tab' } };
    } };
    const h = await makeHarness({ getRuntime: () => runtime });
    try {
      const response = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: {
        action: 'upload', targetId: 'tab', paths: ['/fake/bundle.aab'], afterSnapshot: {},
      } } });
      expect(response.isError).toBe(false);
      expect(JSON.parse((response.content as Array<{ text: string }>)[0].text)).toMatchObject({
        ok: true, action: 'upload', afterSnapshot: { ok: false, action: 'snapshot', message: 'page closed' },
      });
      expect(uploads).toBe(1);
    } finally { await h.cleanup(); }
  });

  it('does not read a new snapshot after a failed action', async () => {
    const calls: string[] = [];
    const h = await makeHarness({ getRuntime: () => ({ async call(req) {
      calls.push(req.action);
      return { ok: false, action: req.action, message: 'stale ref' };
    } }) });
    try {
      const response = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: {
        action: 'act', request: { kind: 'click', ref: 'e1' }, afterSnapshot: {},
      } } });
      expect(response.isError).toBe(true);
      expect(calls).toEqual(['act']);
    } finally { await h.cleanup(); }
  });

  it.each([{ action: 'stop' }, { action: 'setBackend', backend: 'external' }, { action: 'act', request: { kind: 'close' } }])('rejects incompatible post-action observation before any side effect: %j', async (args) => {
    const h = await makeHarness({ setBackend: async () => { throw new Error('must not switch'); } });
    try {
      const response = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { ...args, afterSnapshot: {} } } });
      expect(response.isError).toBe(true);
      expect(h.calls).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it('switches modes in the same MCP instance and immediately updates backend capabilities', async () => {
    let backend: 'external' | 'rsb-webview' = 'external';
    const switched: string[] = [];
    const h = await makeHarness({
      setBackend: async (next) => { switched.push(next); backend = next; return backend; },
      supportsSemanticQueries: () => backend === 'rsb-webview',
      supportsResourceDownloads: () => backend === 'rsb-webview',
    });
    const call = (args: Record<string, unknown>) => h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args } });
    try {
      for (const next of ['rsb-webview', 'rsb-webview', 'external'] as const) {
        const changed = await call({ action: 'setBackend', backend: next });
        expect(JSON.parse((changed.content as Array<{ text: string }>)[0].text)).toMatchObject({
          ok: true, action: 'setBackend', data: { backend: next, scope: 'global', persisted: true },
        });
        for (const request of [
          { kind: 'click', query: { role: 'button', name: 'Submit' } },
          { kind: 'saveResource', url: 'https://example.test/resource.png' },
        ]) {
          const result = await call({ action: 'act', targetId: 'fresh-tab', request });
          expect(Boolean(result.isError)).toBe(next === 'external');
        }
      }
      expect(switched).toEqual(['rsb-webview', 'rsb-webview', 'external']);
      expect(h.calls).toHaveLength(4);
      expect(h.calls.every((request) => (request as { action: string }).action === 'act')).toBe(true);
    } finally { await h.cleanup(); }
  });

  it.each([
    { action: 'setBackend' },
    { action: 'setBackend', backend: 'chrome' },
    { action: 'open', backend: 'rsb-webview', url: 'https://example.test/' },
  ])('rejects invalid mode arguments without navigation or switching: %j', async (args) => {
    let switches = 0;
    const h = await makeHarness({ setBackend: async (next) => { switches++; return next; } });
    try {
      const result = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args } });
      expect(result.isError).toBe(true);
      expect(switches).toBe(0);
      expect(h.calls).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it.each([
    {},
    { setBackend: async () => { throw new Error('switch failed'); } },
    { setBackend: async () => 'external' as const },
  ])('reports unsupported, failed or superseded switches without claiming success', async (deps) => {
    const h = await makeHarness(deps);
    try {
      const result = await h.client.callTool({
        name: 'call_tool', arguments: { name: 'browser', args: { action: 'setBackend', backend: 'rsb-webview' } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).ok).toBe(false);
      expect(h.calls).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it('lists browser automation entry tools', async () => {
    const h = await makeHarness();
    const result = await h.client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['call_tool', 'list_tools']);
    await h.cleanup();
  });

  it('bundles the browser-workflow rule into list_tools(category)', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'list_tools',
      arguments: { category: 'browser' },
    });

    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const parsed = JSON.parse(first.text) as {
      ok: boolean;
      tools: Array<{ name: string; rules?: string[] }>;
      rules?: Record<string, string>;
    };
    expect(parsed.ok).toBe(true);
    // the `browser` tool references the rule keys…
    expect(parsed.tools.find((t) => t.name === 'browser')?.rules).toEqual(['browser-workflow', 'recipe-author']);
    // …and each full markdown body is bundled once at the top level.
    expect(parsed.rules?.['browser-workflow']).toContain('snapshot');
    expect(parsed.rules?.['recipe-author']).toContain('saveRecipe');
    await h.cleanup();
  });

  it('dispatches browser calls through the injected runtime', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'navigate',
          url: 'https://example.com',
          profile: 'default',
        },
      },
    });

    expect(h.calls).toEqual([
      {
        action: 'navigate',
        url: 'https://example.com',
        profile: 'default',
      },
    ]);
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    expect(JSON.parse(first.text)).toMatchObject({ ok: true, action: 'navigate' });
    await h.cleanup();
  });

  it('accepts proxyServer for start and forwards it unchanged to the host', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'start',
          proxyServer: 'http://proxy.example:8080',
          proxyAllowedHostnames: ['auth.example.com', '*.service.example.com'],
        },
      },
    });

    expect(h.calls).toEqual([{
      action: 'start',
      proxyServer: 'http://proxy.example:8080',
      proxyAllowedHostnames: ['auth.example.com', '*.service.example.com'],
    }]);
    expect(result.isError).not.toBe(true);
    await h.cleanup();
  });

  it('rejects proxyServer for non-start actions without echoing credentials', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'status',
          proxyServer: 'http://proxy.example:8080',
        },
      },
    });

    expect(h.calls).toEqual([]);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(text).not.toMatch(/p%40ss/);
    await h.cleanup();
  });

  it('passes through the network actions (requests / responseBody)', async () => {
    const h = await makeHarness();
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'requests', filter: '/api/', clear: true, targetId: 't1' },
      },
    });
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'responseBody', url: 'https://x/api/items', maxChars: 20000 },
      },
    });

    expect(h.calls).toEqual([
      { action: 'requests', filter: '/api/', clear: true, targetId: 't1' },
      { action: 'responseBody', url: 'https://x/api/items', maxChars: 20000 },
    ]);
    await h.cleanup();
  });

  it('passes through a page resource and rejects unsafe resource URLs', async () => {
    const h = await makeHarness();
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'act',
          targetId: 't1',
          request: {
            kind: 'saveResource',
            url: 'https://cdn.example.test/archive.zip',
          },
        },
      },
    });
    expect(h.calls).toEqual([
      {
        action: 'act',
        targetId: 't1',
        request: {
          kind: 'saveResource',
          url: 'https://cdn.example.test/archive.zip',
        },
      },
    ]);

    const blocked = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'act',
          targetId: 't1',
          request: { kind: 'saveResource', url: 'file:///tmp/secret' },
        },
      },
    });
    expect(h.calls).toHaveLength(1);
    const parsed = JSON.parse(
      (blocked.content as Array<{ text: string }>)[0].text,
    ) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/http\(s\)/);

    const credentialed = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'act',
          targetId: 't1',
          request: {
            kind: 'saveResource',
            url: 'https://user:secret@cdn.example.test/archive.zip',
          },
        },
      },
    });
    expect(h.calls).toHaveLength(1);
    const credentialedResult = JSON.parse(
      (credentialed.content as Array<{ text: string }>)[0].text,
    ) as { ok: boolean };
    expect(credentialedResult.ok).toBe(false);
    await h.cleanup();
  });

  it('re-evaluates resource download support when the backend changes', async () => {
    let downloadsSupported = true;
    const h = await makeHarness({
      supportsResourceDownloads: () => downloadsSupported,
    });
    const request = {
      name: 'browser',
      args: {
        action: 'act',
        targetId: 't1',
        request: {
          kind: 'saveResource',
          url: 'https://cdn.example.test/archive.zip',
        },
      },
    };

    await h.client.callTool({ name: 'call_tool', arguments: request });
    expect(h.calls).toHaveLength(1);

    downloadsSupported = false;
    const blocked = await h.client.callTool({ name: 'call_tool', arguments: request });
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse((blocked.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });

    downloadsSupported = true;
    await h.client.callTool({ name: 'call_tool', arguments: request });
    expect(h.calls).toHaveLength(2);
    await h.cleanup();
  });

  it('rejects semantic queries when the active backend does not support them', async () => {
    let semanticQueriesSupported = true;
    const h = await makeHarness({
      supportsSemanticQueries: () => semanticQueriesSupported,
    });
    const request = {
      name: 'browser',
      args: {
        action: 'act',
        targetId: 't1',
        request: {
          kind: 'click',
          query: { role: 'button', name: 'Continue' },
        },
      },
    };

    await h.client.callTool({ name: 'call_tool', arguments: request });
    expect(h.calls).toHaveLength(1);

    semanticQueriesSupported = false;
    const blocked = await h.client.callTool({ name: 'call_tool', arguments: request });
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse((blocked.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
    await h.cleanup();
  });

  it('rejects blank element query strings before calling the runtime', async () => {
    const h = await makeHarness();
    for (const field of ['css', 'role', 'name', 'text', 'label', 'placeholder', 'testId']) {
      const blocked = await h.client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'browser',
          args: {
            action: 'act',
            targetId: 't1',
            request: {
              kind: 'click',
              query: { [field]: '   ' },
            },
          },
        },
      });
      expect(JSON.parse((blocked.content as Array<{ text: string }>)[0].text)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_ARGS',
      });
    }
    expect(h.calls).toHaveLength(0);
    await h.cleanup();
  });

  it('compiles extract into an act:evaluate call', async () => {
    const h = await makeHarness();
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'extract',
          targetId: 't1',
          extract: { from: '.book', multiple: true, fields: { title: 'h3', price: '.price_color' } },
        },
      },
    });

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0] as { action: string; targetId?: string; request?: { kind: string; fn: string } };
    expect(call.action).toBe('act');
    expect(call.targetId).toBe('t1');
    expect(call.request?.kind).toBe('evaluate');
    // The compiled fn carries the field schema and is a function source.
    expect(call.request?.fn).toContain('querySelectorAll');
    expect(call.request?.fn).toContain('.book');
    await h.cleanup();
  });

  it('rejects extract without an extract spec', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'extract' } },
    });
    expect(h.calls).toHaveLength(0);
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    expect(JSON.parse(first.text)).toMatchObject({ ok: false, action: 'extract' });
    await h.cleanup();
  });

  it('pre-empts the "selector@attr" mistake with a teaching error (no runtime call)', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'extract', extract: { from: 'article', multiple: true, fields: { title: 'h3 a@title' } } },
      },
    });
    // caught before dispatch — the runtime is never hit.
    expect(h.calls).toHaveLength(0);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('@');
    expect(parsed.message).toContain('attr'); // shows the correct {selector, attr} form
    await h.cleanup();
  });

  it('rejects frame-scoped extract (vendored evaluate has no frame support) — no runtime call', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'extract',
          frame: 'iframe#widget',
          extract: { from: '.b', multiple: true, fields: { t: 'h3' } },
        },
      },
    });
    // rejected loudly before dispatch — never silently runs against the main doc.
    expect(h.calls).toHaveLength(0);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('frame');
    await h.cleanup();
  });

  it('runs a bundled recipe end to end against the runtime', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'recipe', recipeId: 'wechat-article', inputs: { url: 'https://mp.weixin.qq.com/' } },
      },
    });

    // navigate → wait → evaluate, all dispatched through the runtime.
    expect((h.calls[0] as { action: string; url?: string })).toMatchObject({
      action: 'navigate',
      url: 'https://mp.weixin.qq.com/',
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed).toMatchObject({ ok: true, action: 'recipe', recipe: 'wechat-article' });
    await h.cleanup();
  });

  it('threads the caller targetId into every recipe step (steps run on the selected tab)', async () => {
    const h = await makeHarness();
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'recipe', recipeId: 'wechat-article', targetId: 'tab-7', inputs: { url: 'https://mp.weixin.qq.com/' } },
      },
    });
    // Without threading, steps fall back to the runtime's default/last tab.
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) {
      expect((c as { targetId?: string }).targetId).toBe('tab-7');
    }
    await h.cleanup();
  });

  it('adopts the targetId a navigate returns (Chromium target swap) for later steps', async () => {
    // The vendored /navigate route resolves a replacement targetId post-navigation;
    // when the first step (navigate) hands back 'tab-NEW', subsequent extract/act
    // steps must run on it, not the stale caller-pinned 'tab-7'.
    const h = await makeHarness(undefined, (req, i) =>
      i === 0 && req.action === 'navigate' ? { targetId: 'tab-NEW' } : undefined,
    );
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'recipe', recipeId: 'wechat-article', targetId: 'tab-7', inputs: { url: 'https://mp.weixin.qq.com/' } },
      },
    });
    const ids = h.calls.map((c) => (c as { targetId?: string }).targetId);
    expect(ids[0]).toBe('tab-7'); // navigate ran on the pinned tab
    expect(ids.slice(1)).not.toContain('tab-7'); // later steps moved off the stale id
    for (const id of ids.slice(1)) expect(id).toBe('tab-NEW');
    await h.cleanup();
  });

  it('adopts the navigate targetId even without a caller-pinned tab (avoids last-selected ambiguity)', async () => {
    // No targetId passed: the first navigate (i=0) carries none, but once it hands
    // back 'tab-NEW' the recipe pins to it so later steps don't fall back to the
    // runtime's "last-selected" tab (ambiguous when multiple tabs are open).
    const h = await makeHarness(undefined, (req, i) =>
      i === 0 && req.action === 'navigate' ? { targetId: 'tab-NEW' } : undefined,
    );
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'recipe', recipeId: 'wechat-article', inputs: { url: 'https://mp.weixin.qq.com/' } },
      },
    });
    const ids = h.calls.map((c) => (c as { targetId?: string }).targetId);
    expect(ids[0]).toBeUndefined(); // navigate ran with no pinned tab
    for (const id of ids.slice(1)) expect(id).toBe('tab-NEW'); // later steps adopted it
    await h.cleanup();
  });

  it('reports a clear error for an unknown recipe', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'recipe', recipeId: 'does-not-exist' } },
    });
    expect(h.calls).toHaveLength(0);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed).toMatchObject({ ok: false, action: 'recipe' });
    await h.cleanup();
  });

  it('merges a user (L2) recipe layer: user-only runs, builtin override flows provenance', async () => {
    const h = await makeHarness({
      getUserRecipes: async () => ({
        recipes: new Map([
          // overrides the bundled wechat-article
          ['wechat-article', { id: 'wechat-article', steps: [{ action: 'navigate', url: 'https://user-override/' }] }],
          // brand-new user-only recipe
          ['my-recipe', { id: 'my-recipe', steps: [{ action: 'navigate', url: 'https://mine/' }] }],
        ]),
        siteGuides: new Map([['mp.weixin.qq.com', { site: 'mp.weixin.qq.com', notes: 'user note' }]]),
        version: 'user-v1',
      }),
    });

    // user-only recipe is runnable
    const r1 = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'recipe', recipeId: 'my-recipe' } },
    });
    expect((h.calls[0] as { url?: string }).url).toBe('https://mine/');
    expect(JSON.parse((r1.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: true,
      provenance: 'user',
    });

    // overridden builtin → user version + provenance 'overridden'
    const r2 = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'siteguide', site: 'mp.weixin.qq.com' } },
    });
    expect(JSON.parse((r2.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: true,
      provenance: 'overridden',
      data: { notes: 'user note' },
    });
    await h.cleanup();
  });

  it('siteguide discovery surfaces recipes no guide lists (saveRecipe-without-guide stays discoverable)', async () => {
    const h = await makeHarness({
      getUserRecipes: async () => ({
        recipes: new Map([
          // saved via saveRecipe with NO accompanying site guide → would be
          // undiscoverable if discovery only walked guides.
          [
            'orphan-recipe',
            {
              id: 'orphan-recipe',
              match: ['example.com'],
              inputs: { q: { required: true } },
              steps: [{ action: 'navigate', url: 'https://example.com/' }],
            },
          ],
        ]),
        siteGuides: new Map(), // no guide references it
        version: 'user-orphan-v1',
      }),
    });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'siteguide' } }, // no site = discovery catalog
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      ok: boolean;
      recipesWithoutGuide?: Array<{ id: string; match: string[]; required: string[] }>;
    };
    expect(parsed.ok).toBe(true);
    const orphan = parsed.recipesWithoutGuide?.find((r) => r.id === 'orphan-recipe');
    expect(orphan).toBeTruthy();
    expect(orphan?.match).toContain('example.com');
    expect(orphan?.required).toContain('q'); // input schema still surfaced for first-try use
    await h.cleanup();
  });

  it('saveRecipe validates the draft, then calls the host writer (self-grow)', async () => {
    const saved: unknown[] = [];
    const h = await makeHarness({
      saveUserRecipe: async (input) => {
        saved.push(input);
        return { ok: true, path: '/tmp/browser-recipes/x.com/recipe.json' };
      },
    }, (_req, i) => ({ result: i === 0 ? true : { title: 'found' } }));
    const recipeDraft = { id: 'x-search', steps: [{ action: 'evaluate', fn: '() => ({title: "found"})',
      guard: { url: 'https://x.com/' }, expect: { requiredFields: ['title'] }, as: 'items' }], output: '{{items}}' };
    const trial = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: {
      action: 'recipe', site: 'x.com', recipeDraft,
    } } });
    expect(trial.isError).toBe(false);
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'saveRecipe',
          site: 'x.com',
          recipeDraft,
        },
      },
    });
    expect(saved).toHaveLength(1);
    expect((saved[0] as { site: string }).site).toBe('x.com');
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: true,
      action: 'saveRecipe',
    });
    await h.cleanup();
  });

  it('saveRecipe rejects an invalid draft with a schema error and never writes', async () => {
    const saved: unknown[] = [];
    const h = await makeHarness({
      saveUserRecipe: async (input) => {
        saved.push(input);
        return { ok: true };
      },
    });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        // missing `steps` → RecipeSchema rejects
        name: 'browser',
        args: { action: 'saveRecipe', site: 'x.com', recipeDraft: { id: 'broken' } },
      },
    });
    expect(saved).toHaveLength(0); // writer never called
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: false,
      action: 'saveRecipe',
    });
    await h.cleanup();
  });

  it('saveRecipe rejects a site guide whose embedded site differs from `site` (no cross-site shadowing)', async () => {
    const saved: unknown[] = [];
    const h = await makeHarness({
      saveUserRecipe: async (input) => {
        saved.push(input);
        return { ok: true };
      },
    });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'saveRecipe',
          site: 'a.com',
          recipeDraft: { id: 'a-x', steps: [{ action: 'navigate', url: 'https://a.com' }] },
          // would be written under a.com/ but indexed by b.com → shadowing
          siteGuideDraft: { site: 'b.com', notes: 'evil' },
        },
      },
    });
    expect(saved).toHaveLength(0); // writer never called
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/必须与 site/);
    await h.cleanup();
  });

  it('lists the whole catalog when siteguide is called without a site (discovery)', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'siteguide' } },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      ok: boolean;
      siteCount?: number;
      sites?: Array<{ site: string; recipes: Array<{ id: string; inputs: string[]; required: string[] }> }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.siteCount).toBeGreaterThan(0);
    // catalog enumerates known sites + each recipe's input schema (so the agent
    // passes required inputs first-try instead of failing into "missing required input").
    const books = parsed.sites?.find((s) => s.site === 'mp.weixin.qq.com');
    expect(books?.recipes.map((r) => r.id)).toContain('wechat-article');
    const hn = parsed.sites?.find((s) => s.site === 'news.ycombinator.com');
    const hnSearch = hn?.recipes.find((r) => r.id === 'hn-search');
    expect(hnSearch?.required).toContain('query');
    await h.cleanup();
  });

  it('returns bundled siteguide knowledge on demand', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'siteguide', site: 'mp.weixin.qq.com' } },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      ok: boolean;
      data?: { site?: string; recipes?: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.site).toBe('mp.weixin.qq.com');
    expect(parsed.data?.recipes).toContain('wechat-article');
    await h.cleanup();
  });

  it('rejects a non-http(s) url (file://) at the boundary, never dispatching', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'navigate', url: 'file:///etc/passwd' } },
    });
    expect(h.calls).toHaveLength(0); // blocked before the runtime
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/http\(s\)/);
    await h.cleanup();
  });

  it('does NOT scheme-guard responseBody (its url is a match pattern, not a navigable URL)', async () => {
    const h = await makeHarness();
    // `api/quotes` is a documented substring pattern — it must dispatch, not be
    // rejected for failing to parse as http(s).
    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'responseBody', url: 'api/quotes' } },
    });
    expect(h.calls).toEqual([{ action: 'responseBody', url: 'api/quotes' }]);
    await h.cleanup();
  });

  it('truncates an oversized runtime result and flags truncated:true', async () => {
    const big = 'x'.repeat(300_000);
    const runtime: BrowserControlRuntime = {
      async call(req) {
        return { ok: true, action: req.action, data: { blob: big } };
      },
    };
    const h = await makeHarness({ getRuntime: () => runtime });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'snapshot', targetId: 't1' } },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      truncated?: boolean;
      bytes?: number;
      limit?: number;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes ?? 0).toBeGreaterThan(parsed.limit ?? 0);
    await h.cleanup();
  });

  it('returns oversized screenshots as bounded image blocks without leaking binary text', async () => {
    const original = Buffer.alloc(240_000, 0xab);
    const compressed = Buffer.from('compressed-webp');
    const h = await makeHarness(
      {
        resolveScreenshot: async () => ({ buffer: original, mimeType: 'image/png' }),
        compressInlineImage: async () => ({ buffer: compressed, mime: 'image/webp' }),
      },
      () => ({
        path: '/private/browser-runtime/media/browser/screenshot.png',
        targetId: 'tab-1',
        url: 'https://example.com/',
      }),
    );

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'screenshot', targetId: 'tab-1' } },
    });

    expect(result.isError).not.toBe(true);
    const content = result.content as Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    expect(content).toHaveLength(2);
    const textBlock = content[0];
    expect(textBlock.type).toBe('text');
    const metadata = JSON.parse('text' in textBlock ? textBlock.text : '{}') as {
      data?: Record<string, unknown>;
      truncated?: boolean;
    };
    expect(metadata.truncated).not.toBe(true);
    expect(metadata.data).toMatchObject({
      targetId: 'tab-1',
      url: 'https://example.com/',
      mimeType: 'image/webp',
      bytes: compressed.byteLength,
    });
    expect(metadata.data).not.toHaveProperty('path');
    expect(metadata.data).not.toHaveProperty('data');
    expect('text' in textBlock ? textBlock.text : '').not.toContain(original.toString('base64'));
    expect(content[1]).toEqual({
      type: 'image',
      data: compressed.toString('base64'),
      mimeType: 'image/webp',
    });
    await h.cleanup();
  });

  it('reports compressor degradation (null) as COMPRESSION_UNAVAILABLE, not TOO_LARGE', async () => {
    // CompressInlineImageFn 契约:null = 压缩器不可用/解码失败/超时的预期降级,
    // 不代表图片本身无法缩小 — 错误码必须与"压缩后仍超标"区分开。
    const original = Buffer.alloc(240_000, 0xab);
    const h = await makeHarness(
      {
        resolveScreenshot: async () => ({ buffer: original, mimeType: 'image/png' }),
        compressInlineImage: async () => null,
      },
      () => ({
        data: original.toString('base64'),
        mimeType: 'image/png',
        bytes: original.byteLength,
        tabId: 'tab-1',
      }),
    );

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'screenshot', targetId: 'tab-1' } },
    });

    expect(result.isError).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.type).toBe('text');
    expect(JSON.parse(block.text ?? '{}')).toMatchObject({
      ok: false,
      action: 'screenshot',
      errorCode: 'BROWSER_SCREENSHOT_COMPRESSION_UNAVAILABLE',
    });
    expect(block.text).not.toContain(original.toString('base64'));
    await h.cleanup();
  });

  it('fails closed with TOO_LARGE only when the compressed copy still exceeds the inline budget', async () => {
    const original = Buffer.alloc(400_000, 0xab);
    const stillOversized = Buffer.alloc(INLINE_IMAGE_TARGET_BYTES + 1, 0xcd);
    const h = await makeHarness(
      {
        resolveScreenshot: async () => ({ buffer: original, mimeType: 'image/png' }),
        compressInlineImage: async () => ({ buffer: stillOversized, mime: 'image/webp' }),
      },
      () => ({
        data: original.toString('base64'),
        mimeType: 'image/png',
        bytes: original.byteLength,
        tabId: 'tab-1',
      }),
    );

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'screenshot', targetId: 'tab-1' } },
    });

    expect(result.isError).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0].text ?? '{}')).toMatchObject({
      ok: false,
      action: 'screenshot',
      errorCode: 'BROWSER_SCREENSHOT_TOO_LARGE',
    });
    expect(blocks[0].text).not.toContain(original.toString('base64'));
    expect(blocks[0].text).not.toContain(stillOversized.toString('base64'));
    await h.cleanup();
  });

  it('maps resolveScreenshot rejections to BROWSER_SCREENSHOT_INVALID without leaking details', async () => {
    // resolver 的 8 类校验 throw(路径越界 / Base64 损坏 / MIME 不匹配等)必须
    // 收敛为稳定的 BROWSER_SCREENSHOT_INVALID,而不是穿透外层 catch 被泛化成
    // BROWSER_RUNTIME_ACTION_FAILED;error 里的路径不得进入模型可见结果。
    const secretPath = '/private/browser-runtime/media/browser/secret-screenshot.png';
    const h = await makeHarness(
      {
        resolveScreenshot: async () => {
          throw new Error(`Browser screenshot file is unavailable: ${secretPath}`);
        },
      },
      () => ({
        path: secretPath,
        targetId: 'tab-1',
      }),
    );

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'screenshot', targetId: 'tab-1' } },
    });

    expect(result.isError).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(JSON.parse(blocks[0].text ?? '{}')).toMatchObject({
      ok: false,
      action: 'screenshot',
      errorCode: 'BROWSER_SCREENSHOT_INVALID',
    });
    expect(blocks[0].text).not.toContain(secretPath);
    expect(blocks[0].text).not.toContain('BROWSER_RUNTIME_ACTION_FAILED');
    await h.cleanup();
  });

  it('keeps the complete screenshot tool result below the stream-json atomic-write budget', async () => {
    const screenshot = Buffer.alloc(INLINE_IMAGE_TARGET_BYTES, 0xab);
    const annotationMarker = 'must-not-enter-result';
    const h = await makeHarness(
      {
        resolveScreenshot: async () => ({ buffer: screenshot, mimeType: 'image/png' }),
      },
      () => ({
        path: '/private/browser-runtime/media/browser/screenshot.png',
        targetId: 'tab-1',
        url: 'https://example.com/',
        labels: true,
        labelsCount: 10_000,
        annotations: Array.from({ length: 10_000 }, () => ({ text: annotationMarker.repeat(20) })),
      }),
    );

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'screenshot', targetId: 'tab-1' } },
    });

    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(256 * 1024);
    expect(serialized).not.toContain(annotationMarker);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      action: 'screenshot',
      data: {
        targetId: 'tab-1',
        labels: true,
        labelsCount: 10_000,
        annotationCount: 10_000,
      },
    });
    await h.cleanup();
  });

  it('keeps the truncated payload within the cap even for quote-heavy content (no double-escape blowup)', async () => {
    // A quote/backslash-heavy blob: the preview gets re-escaped by the outer
    // JSON.stringify, so a naive slice-to-cap would emit ~2x the cap. The final
    // MCP text must still respect MAX_RESULT_BYTES (200_000).
    const big = '"\\'.repeat(200_000); // 400k chars, every one escapes to 2
    const runtime: BrowserControlRuntime = {
      async call(req) {
        return { ok: true, action: req.action, data: { blob: big } };
      },
    };
    const h = await makeHarness({ getRuntime: () => runtime });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'snapshot', targetId: 't1' } },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text.length).toBeLessThanOrEqual(200_000);
    const parsed = JSON.parse(text) as { truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    await h.cleanup();
  });

  it.each([true, false])('points the agent at 代输入 when a snapshot shows a password field (%s)', async (password) => {
    const h = await makeHarness({}, (request) => request.action === 'act'
      ? { result: { password, code: false } }
      : { targetId: 't9', snapshot: '- textbox "Password" [ref=e3]' });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'snapshot' } },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as { loginWall?: { fields: string[]; hint: string }; ok: boolean };
    expect(parsed.ok).toBe(true);
    if (password) {
      expect(text.startsWith('{"loginWall"')).toBe(true);
      expect(parsed.loginWall).toMatchObject({ fields: ['password'], hint: expect.stringContaining('request_input_handoff') });
    } else {
      expect(parsed.loginWall).toBeUndefined();
    }
    // The check runs on the tab the snapshot came from.
    expect(h.calls[1]).toMatchObject({ action: 'act', targetId: 't9', request: { kind: 'evaluate' } });
    await h.cleanup();
  });

  it('pauses page-state reads on a page where the owner just typed a secret', async () => {
    let restricted = true;
    const asked: unknown[] = [];
    const h = await makeHarness({
      pageReadsRestricted: async (target) => { asked.push(target); return restricted; },
    });
    const call = async (args: Record<string, unknown>) => JSON.parse(((await h.client.callTool({
      name: 'call_tool', arguments: { name: 'browser', args },
    })).content as Array<{ text: string }>)[0].text) as { ok: boolean; data?: { reason?: string } };
    try {
      for (const args of [
        { action: 'act', targetId: 't1', request: { kind: 'evaluate', fn: '() => 1' } },
        { action: 'requests', targetId: 't1' },
        { action: 'console', targetId: 't1' },
      ]) {
        expect(await call(args)).toMatchObject({ ok: false, data: { reason: 'secret_entered' } });
      }
      expect(asked[0]).toEqual({ targetId: 't1' });
      expect(h.calls).toEqual([]);
      // Reading the page's structure and clicking stay available.
      expect(await call({ action: 'act', targetId: 't1', request: { kind: 'click', ref: 'e1' } })).toMatchObject({ ok: true });
      restricted = false;
      expect(await call({ action: 'console', targetId: 't1' })).toMatchObject({ ok: true });
    } finally {
      await h.cleanup();
    }
  });
});

// Real MCP entry, no model stub: receipts, repair limits and persisted suspension.
describe('recipe on-use maintenance', () => {
  const draft = { id: 'maintenance-flow', steps: [{ action: 'evaluate' as const, fn: '() => ({title: "found"})',
    guard: { url: 'https://example.com/' }, expect: { requiredFields: ['title'] }, as: 'items' }], output: '{{items}}' };
  async function invoke(h: Awaited<ReturnType<typeof makeHarness>>, args: Record<string, unknown>) {
    const r = await h.client.callTool({ name: 'call_tool', arguments: { name: 'browser', args } });
    return JSON.parse((r.content as Array<{text: string}>)[0].text);
  }
  it('rejects unverified/modified/forged drafts and keeps evidence session-local', async () => {
    const saved: unknown[] = [];
    const deps = { saveUserRecipe: async (x: unknown) => { saved.push(x); return { ok: true }; } };
    const h = await makeHarness(deps, (_req, i) => ({ result: i % 2 === 0 ? true : { title: 'found' } }));
    const other = await makeHarness(deps);
    try {
      const save = { action: 'saveRecipe', site: 'example.com', recipeDraft: draft };
      expect((await invoke(h, save)).ok).toBe(false);
      expect((await invoke(h, { ...save, action: 'recipe' })).verified).toBe(true);
      expect((await invoke(other, save)).ok).toBe(false);
      expect((await invoke(h, { ...save, recipeDraft: { ...draft, description: 'changed' } })).ok).toBe(false);
      expect((await invoke(h, { ...save, recipeDraft: { ...draft, validation: { site: 'example.com', state: 'active' } } })).ok).toBe(false);
      expect((await invoke(h, save)).ok).toBe(true);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ recipe: { validation: { state: 'active' } } });
    } finally { await h.cleanup(); await other.cleanup(); }
  });
  it('does not suspend a valid recipe when the caller omitted inputs', async () => {
    const saved: unknown[] = [];
    const stored = { ...draft, inputs: { query: { required: true } }, validation: { site: 'example.com', state: 'active' as const } };
    const h = await makeHarness({
      getUserRecipes: async () => ({ version: 'maintenance-missing-input', recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
      saveUserRecipe: async (x) => { saved.push(x); return { ok: true }; },
    }, (_req, i) => ({ result: i === 0 ? true : { title: 'found' } }));
    try {
      expect((await invoke(h, { action: 'recipe', recipeId: stored.id })).ok).toBe(false);
      expect(h.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
      expect((await invoke(h, { action: 'recipe', recipeId: stored.id, inputs: { query: 'test' } })).ok).toBe(true);
    } finally { await h.cleanup(); }
  });
  // Review #6822: saved-use coverage above did not exercise repair preflight.
  // MCP entry/unit: all three preflight paths must leave the page and budget untouched.
  it.each(['missing', 'non-scalar', 'interpolation', 'equals'] as const)('preserves the repair trial after %s input preflight failure', async (failure) => {
    const candidate = { ...draft, inputs: { query: { required: true } }, steps: [{ ...draft.steps[0],
      ...(failure === 'equals' ? { expect: { equals: { title: '{{missing}}' } } } : {}),
      guard: { url: 'https://example.com/', ...(failure === 'interpolation' ? { selector: '#{{missing}}' } : {}) } }] };
    const stored = { ...candidate, validation: { site: 'example.com', state: 'suspended' as const } };
    const saved: unknown[] = [];
    const h = await makeHarness({
      getUserRecipes: async () => ({ version: `repair-preflight-${failure}`, recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
      saveUserRecipe: async (x) => { saved.push(x); return { ok: true }; },
    }, (_req, i) => ({ result: i === 0 ? true : { title: 'found' } }));
    const run = { action: 'recipe', site: 'example.com', recipeDraft: candidate };
    try {
      const inputs = failure === 'missing' ? undefined : { query: failure === 'non-scalar' ? {} : 'test' };
      expect((await invoke(h, { ...run, inputs })).ok).toBe(false);
      expect(h.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
      expect((await invoke(h, { ...run, inputs: { query: 'test', missing: 'found' } })).verified).toBe(true);
      const calls = h.calls.length;
      expect((await invoke(h, { ...run, inputs: { query: 'test', missing: 'found' } })).message).toContain('次数已用完');
      expect(h.calls).toHaveLength(calls);
    } finally { await h.cleanup(); }
  });
  // Review #6822: a draft failure differs from failure of the saved definition.
  // MCP entry/unit: guard/expect failures must not disable the old working recipe.
  it.each(['guard', 'expect'] as const)('keeps an active recipe usable after a candidate %s failure', async (failure) => {
    const stored = { ...draft, validation: { site: 'example.com', state: 'active' as const } };
    const saved: unknown[] = [];
    let trial = true;
    const h = await makeHarness({
      getUserRecipes: async () => ({ version: `active-draft-${failure}`, recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
      saveUserRecipe: async (x) => { saved.push(x); return { ok: true }; },
    }, (req) => ({ result: (req.request as { fn?: string })?.fn?.includes('const g =')
      ? !(trial && failure === 'guard') : { title: trial ? '' : 'found' } }));
    try {
      expect((await invoke(h, { action: 'recipe', site: 'example.com', recipeDraft: draft })).failureKind).toBe(failure);
      expect(saved).toHaveLength(0);
      trial = false;
      expect((await invoke(h, { action: 'recipe', recipeId: stored.id })).ok).toBe(true);
      expect((await invoke(h, { action: 'recipe', site: 'example.com', recipeDraft: draft })).verified).toBe(true);
      expect(saved).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('rejects moving an existing recipe id to a different site', async () => {
    const stored = { ...draft, validation: { site: 'example.com', state: 'active' as const } };
    const h = await makeHarness({
      getUserRecipes: async () => ({ version: 'maintenance-wrong-site', recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
    });
    try {
      const moved = { ...draft, steps: [{ ...draft.steps[0], guard: { url: 'https://other.example/' } }] };
      expect((await invoke(h, { action: 'recipe', site: 'other.example', recipeDraft: moved })).message).toContain('原站点');
      expect(h.calls).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  // #6822 dispatch checkpoint: permission denial is neither recipe aging nor a
  // repair attempt. Exercise denial -> permission restored -> real execution,
  // through separate evaluate guards and combined extract reads at the MCP entry.
  it.each([
    { candidate: true, extract: false }, { candidate: true, extract: true },
    { candidate: false, extract: false }, { candidate: false, extract: true },
  ])('preserves recipe state and repair budget across read restriction: %j', async ({ candidate, extract }) => {
    const definition = extract ? { ...draft, steps: [{ action: 'extract' as const,
      guard: draft.steps[0].guard, expect: draft.steps[0].expect,
      extract: { fields: { title: 'h1' } }, as: 'items' }] } : draft;
    const stored = { ...definition, validation: { site: 'example.com', state: candidate ? 'suspended' as const : 'active' as const } };
    const saved: unknown[] = [];
    let restricted = true;
    const h = await makeHarness({
      pageReadsRestricted: async () => restricted,
      getUserRecipes: async () => ({ version: `restricted-${candidate}-${extract}`, recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
      saveUserRecipe: async (x) => { saved.push(x); return { ok: true }; },
    }, (_req, i) => ({ result: extract ? { matched: true, value: { records: [{ title: 'found' }] } } : i === 0 ? true : { title: 'found' } }));
    const run = candidate ? { action: 'recipe', site: 'example.com', recipeDraft: definition } : { action: 'recipe', recipeId: stored.id };
    try {
      expect((await invoke(h, run)).ok).toBe(false);
      expect(h.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
      restricted = false;
      expect((await invoke(h, run)).ok).toBe(true);
      expect(h.calls.length).toBeGreaterThan(0);
      expect(saved).toHaveLength(0);
      if (candidate) {
        const calls = h.calls.length;
        expect((await invoke(h, run)).message).toContain('次数已用完');
        expect(h.calls).toHaveLength(calls);
      }
    } finally { await h.cleanup(); }
  });
  it('persists failure of a legacy recipe using its guide, without replacing it with a failed draft', async () => {
    const saved: unknown[] = [];
    const legacy = { id: 'legacy-guide-flow', steps: [{ action: 'extract' as const, extract: { fields: { title: 'h1' } } }] };
    const h = await makeHarness({
      getUserRecipes: async () => ({ version: 'legacy-guide-flow-v1', recipes: new Map([[legacy.id, legacy]]),
        siteGuides: new Map([['example.com', { site: 'example.com', recipes: [legacy.id] }]]) }),
      saveUserRecipe: async (x) => { saved.push(x); return { ok: true }; },
    }, () => ({ result: { ok: false, error: 'invalid selector' } }));
    try {
      expect((await invoke(h, { action: 'recipe', recipeId: legacy.id })).ok).toBe(false);
      expect(saved).toEqual([{ site: 'example.com', recipe: { ...legacy, validation: { site: 'example.com', state: 'suspended' } } }]);
    } finally { await h.cleanup(); }
  });
  it('reports a failed suspension write and still prevents this session from rerunning it', async () => {
    const stored = { ...draft, validation: { site: 'example.com', state: 'active' as const } };
    const h = await makeHarness({
      getUserRecipes: async () => ({ version: 'maintenance-write-failure', recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
      saveUserRecipe: async () => ({ ok: false, message: 'disk full' }),
    }, () => ({ result: false }));
    try {
      expect((await invoke(h, { action: 'recipe', recipeId: stored.id })).maintenanceMessage).toContain('保存失败');
      expect((await invoke(h, { action: 'recipe', recipeId: stored.id })).ok).toBe(false);
      expect(h.calls).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it('persists suspension, allows one repair, and never automatically replays a completed action', async () => {
    const recipe = { ...draft, steps: [{ action: 'click' as const, selector: '#save', guard: { url: 'https://example.com/' } }, ...draft.steps],
      validation: { site: 'example.com', state: 'active' as 'active' | 'suspended' } };
    let stored = recipe;
    let version = 0;
    let good = false;
    const deps: Partial<BrowserMcpDeps> = {
      getUserRecipes: async () => ({ version: `maintenance-${version}`, recipes: new Map([[stored.id, stored]]), siteGuides: new Map() }),
      saveUserRecipe: async (input) => { stored = input.recipe as typeof recipe; version++; return { ok: true }; },
    };
    const h = await makeHarness(deps, (req) => {
      const fn = (req.request as {fn?: string})?.fn;
      return { result: fn?.includes('const g =') ? true : good ? { title: 'found' } : { title: '' } };
    });
    try {
      expect((await invoke(h, { action: 'recipe', recipeId: recipe.id })).failureKind).toBe('expect');
      expect(stored.validation.state).toBe('suspended');
      expect(h.calls.filter((r) => (r as { request?: {kind: string} }).request?.kind === 'click')).toHaveLength(1);
      const count = h.calls.length;
      expect((await invoke(h, { action: 'recipe', recipeId: recipe.id })).ok).toBe(false);
      expect(h.calls).toHaveLength(count);
      const fresh = await makeHarness(deps);
      try {
        expect((await invoke(fresh, { action: 'recipe', recipeId: recipe.id })).ok).toBe(false);
        expect(fresh.calls).toHaveLength(0);
      } finally { await fresh.cleanup(); }
      // Repair is read-only: verify the already-completed write rather than re-submit.
      expect((await invoke(h, { action: 'recipe', site: 'example.com', recipeDraft: draft })).ok).toBe(false);
      good = true;
      const repairCalls = h.calls.length;
      expect((await invoke(h, { action: 'recipe', site: 'example.com', recipeDraft: draft })).message).toContain('次数已用完');
      expect(h.calls).toHaveLength(repairCalls);
      expect(stored.steps[0].action).toBe('click'); // failed draft did not replace it
      expect((await invoke(h, { action: 'saveRecipe', site: 'example.com', recipeDraft: draft })).ok).toBe(false);
    } finally { await h.cleanup(); }
    // A later task can successfully validate and save a repaired definition.
    const next = await makeHarness(deps, (_r, i) => ({ result: i === 0 ? true : { title: 'found' } }));
    try {
      expect((await invoke(next, { action: 'recipe', site: 'example.com', recipeDraft: draft })).ok).toBe(true);
      expect((await invoke(next, { action: 'saveRecipe', site: 'example.com', recipeDraft: draft })).ok).toBe(true);
      expect(stored.validation.state).toBe('active');
    } finally { await next.cleanup(); }
  });
});
