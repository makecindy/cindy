import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';
import { describe, expect, it } from 'vitest';

import { createBrowserMcpServer } from './server.js';
import type { BrowserMcpDeps } from '../types.js';

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
        args: { action: 'recipe', recipeId: 'books-list', inputs: { url: 'https://books.toscrape.com/' } },
      },
    });

    // navigate → wait → extract, all dispatched through the runtime.
    expect((h.calls[0] as { action: string; url?: string })).toMatchObject({
      action: 'navigate',
      url: 'https://books.toscrape.com/',
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed).toMatchObject({ ok: true, action: 'recipe', recipe: 'books-list' });
    await h.cleanup();
  });

  it('threads the caller targetId into every recipe step (steps run on the selected tab)', async () => {
    const h = await makeHarness();
    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: { action: 'recipe', recipeId: 'books-list', targetId: 'tab-7', inputs: { url: 'https://books.toscrape.com/' } },
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
        args: { action: 'recipe', recipeId: 'books-list', targetId: 'tab-7', inputs: { url: 'https://books.toscrape.com/' } },
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
        args: { action: 'recipe', recipeId: 'books-list', inputs: { url: 'https://books.toscrape.com/' } },
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
          // overrides the bundled books-list
          ['books-list', { id: 'books-list', steps: [{ action: 'navigate', url: 'https://user-override/' }] }],
          // brand-new user-only recipe
          ['my-recipe', { id: 'my-recipe', steps: [{ action: 'navigate', url: 'https://mine/' }] }],
        ]),
        siteGuides: new Map([['books.toscrape.com', { site: 'books.toscrape.com', notes: 'user note' }]]),
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
      arguments: { name: 'browser', args: { action: 'siteguide', site: 'books.toscrape.com' } },
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
    });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'browser',
        args: {
          action: 'saveRecipe',
          site: 'x.com',
          recipeDraft: { id: 'x-search', steps: [{ action: 'navigate', url: 'https://x.com/?q={{q}}' }] },
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
    const books = parsed.sites?.find((s) => s.site === 'books.toscrape.com');
    expect(books?.recipes.map((r) => r.id)).toContain('books-list');
    const hn = parsed.sites?.find((s) => s.site === 'news.ycombinator.com');
    const hnSearch = hn?.recipes.find((r) => r.id === 'hn-search');
    expect(hnSearch?.required).toContain('query');
    await h.cleanup();
  });

  it('returns bundled siteguide knowledge on demand', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'browser', args: { action: 'siteguide', site: 'books.toscrape.com' } },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      ok: boolean;
      data?: { site?: string; recipes?: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.site).toBe('books.toscrape.com');
    expect(parsed.data?.recipes).toContain('books-list');
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
});
