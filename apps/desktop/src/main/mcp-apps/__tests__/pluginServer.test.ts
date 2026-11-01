import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { pluginAppResult } from '../pluginCards.js';
import { PluginAppFiles } from '../pluginFiles.js';
import { createPluginAppTransport, PLUGIN_PAGE_TICKET } from '../pluginServer.js';
import {
  createPageProgressRelay,
  withPluginPageTicket,
  type PluginPageCall,
} from '../pluginPageCall.js';

// Production SDK + virtual server, not a mock transport. Existing HTTP host tests cannot
// protect the new main.js dispatch authority. Minimal failure: an app call without a
// one-use Host ticket, a model-only tool, or a revoked version. Tier: unit, no I/O.
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
const tools = ['open', 'save', 'model_only'].map((name) => ({
  name,
  description: name,
  parameters: { type: 'object' as const },
}));
const ui = {
    resources: [{
            uri: "ui://planner",
            file: 'ui/planner.html',
            csp: { connectDomains: ['https://api.example.com'] },
            prefersBorder: true,
            domain: "retained.example", permissions: { camera: {} }
        }],
    tools: { open: { resourceUri: "ui://planner" }, save: { visibility: ['app' as const] } }
};
async function fixture() {
  let current = true;
  let finish: (() => void) | undefined;
  let called: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    called = resolve;
  });
  const events: string[] = [];
  const assertCurrent = () => {
    if (!current) throw new Error('MCP_APP_SERVER_CHANGED');
  };
  const client = new Client(
    { name: 'host', version: '1' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } },
  );
  clients.push(client);
  await client.connect(
    createPluginAppTransport({
      instance: 'demo',
      revision: 'v1',
      tools,
      ui,
      hosts: ['api.example.com'],
      assertCurrent,
      readHtml: (html) => `<html>${html}</html>`,
      call: async (grant, args) => {
        events.push(grant.sessionId);
        called?.();
        if (args.wait)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return { content: [{ type: 'text', text: JSON.stringify(args) }] };
      },
    }),
  );
  const grant: PluginPageCall = {
    instance: 'demo',
    revision: 'v1',
    tool: 'save',
    sessionId: 'task-a',
    clientId: 'card-a',
    assertCurrent: async () => assertCurrent(),
  };
  return {
    client,
    grant,
    events,
    started,
    revoke: () => {
      current = false;
    },
    finish: () => finish?.(),
  };
}
describe('plugin virtual App server', () => {
  it('projects shared pages and visibility into standard MCP tools and resource metadata', async () => {
    const { client } = await fixture();
    expect((await client.listTools()).tools.map((tool) => tool._meta?.ui)).toEqual([
      { resourceUri: 'ui://planner' },
      { visibility: ['app'] },
      { visibility: ['model'] },
    ]);
    const resource = (await client.readResource({ uri: 'ui://planner' })).contents[0];
    expect(resource).toEqual({
      uri: 'ui://planner',
      mimeType: RESOURCE_MIME_TYPE,
      text: '<html>ui/planner.html</html>',
      _meta: { ui: { csp: ui.resources[0].csp, prefersBorder: true, domain: "retained.example", permissions: { camera: {} } } },
    });
    await expect(client.readResource({ uri: 'ui://other/planner' })).rejects.toThrow(
      'MCP_APP_RESOURCE_NOT_FOUND',
    );
  });
  it('requires a ticket and refuses model-only tools before invoking main.js', async () => {
    const { client, grant, events } = await fixture();
    await expect(client.callTool({ name: 'save' })).rejects.toThrow('MCP_APP_CALL_NOT_AUTHORIZED');
    await withPluginPageTicket({ ...grant, tool: 'model_only' }, async (ticket) => {
      await expect(
        client.callTool({ name: 'model_only', _meta: { [PLUGIN_PAGE_TICKET]: ticket } }),
      ).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
    });
    expect(events).toEqual([]);
  });
  it('binds one-use authority to instance, version and tool and keeps its task context', async () => {
    const { client, grant, events } = await fixture();
    for (const changed of [{ instance: 'other' }, { revision: 'v2' }, { tool: 'open' }]) {
      await withPluginPageTicket({ ...grant, ...changed }, async (ticket) => {
        await expect(
          client.callTool({ name: 'save', _meta: { [PLUGIN_PAGE_TICKET]: ticket } }),
        ).rejects.toThrow('MCP_APP_CALL_NOT_AUTHORIZED');
      });
    }
    await withPluginPageTicket(grant, async (ticket) => {
      const params = {
        name: 'save',
        arguments: { plan: 42 },
        _meta: { [PLUGIN_PAGE_TICKET]: ticket },
      };
      expect(await client.callTool(params)).toEqual({
        content: [{ type: 'text', text: '{"plan":42}' }],
      });
      await expect(client.callTool(params)).rejects.toThrow('MCP_APP_CALL_NOT_AUTHORIZED');
    });
    expect(events).toEqual(['task-a']);
  });
  it('rejects late results and subsequent resource reads after revocation', async () => {
    const { client, grant, started, finish, revoke } = await fixture();
    const result = withPluginPageTicket(grant, (ticket) =>
      client.callTool({
        name: 'save',
        arguments: { wait: true },
        _meta: { [PLUGIN_PAGE_TICKET]: ticket },
      }),
    );
    const rejected = expect(result).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    await started;
    revoke();
    finish();
    await rejected;
    await expect(client.readResource({ uri: 'ui://planner' })).rejects.toThrow(
      'MCP_APP_SERVER_CHANGED',
    );
  });
});

// A1: fast progress updates must not flood the View or survive a finished call.
// Unit tier; virtual clock exercises the production relay's 200ms boundary.
it('coalesces progress and drops queued updates after call completion', async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(async () => {}), relay = createPageProgressRelay(send);
    relay.update({ progress: 1 }); relay.update({ progress: 2 }); relay.update({ progress: 1 });
    await vi.advanceTimersByTimeAsync(199);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith({ progress: 2 }, expect.any(AbortSignal));
    relay.update({ progress: 3 }); relay.close();
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

// A2: production file projection must issue capabilities only for card-supplied
// references, bind them to one View and revoke both new reads and active streams.
// Existing virtual MCP tests contain no file authority. Unit tier, in-memory IO.
it('issues opaque per-View file URLs and rejects other plugin references and stale reads', async () => {
  let current = true, exists = true;
  const uri = 'library:images/photo.png';
  let readSignal: AbortSignal | undefined;
  const access = {
    describe: async (instance: string, ref: string) => instance === 'plugin' && ref === uri && exists ? { size: 12, mimeType: 'image/png' } : null,
    read: async (_instance: string, _ref: string, request: Request) => {
      readSignal = request.signal;
      return new Response(exists ? 'image' : null, { status: exists ? 200 : 404 });
    },
  };
  const assertCurrent = async () => { if (!current) throw new Error('revoked'); };
  const files = new PluginAppFiles('card-a', 'plugin', access, assertCurrent);
  const another = new PluginAppFiles('card-b', 'plugin', access, assertCurrent);
  const input = { content: [{ type: 'resource_link', name: 'Photo', uri }] };
  const result = await files.project(input);
  const link = result.content[0] as typeof input.content[0] & { _meta: Record<string, { url: string }> };
  const url = link._meta['cindy/file'].url;
  expect(url).toMatch(/^cindy-mcp-app:\/\/card-a-view\/__cindy\/files\/[a-f0-9-]+$/);
  expect(input.content[0]).not.toHaveProperty('_meta');
  const token = url.split('/').pop()!;
  expect((await another.read(token, new Request(url))).status).toBe(404);
  expect((await files.read('forged', new Request(url))).status).toBe(404);
  await expect(files.project({ type: 'resource_link', uri: 'library:../other/file' })).rejects.toThrow('MCP_APP_FILE_NOT_AUTHORIZED');
  expect(await (await files.read(token, new Request(url))).text()).toBe('image');
  exists = false;
  expect((await files.read(token, new Request(url))).status).toBe(404);
  current = false;
  await expect(files.read(token, new Request(url))).rejects.toThrow('revoked');
  files.close();
  expect(readSignal?.aborted).toBe(true);
  current = true;
  await expect(files.read(token, new Request(url))).rejects.toThrow();
  another.close();
});

// Chat file handoff: card attachments sign only this instance's live copies; a
// deleted or foreign copy stays as name/size so the View still opens. Rule:
// plugin-security-and-authoring.md §4. Unit tier, real store + file access.
it('signs live handoff copies and keeps unavailable attachments unsigned', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { GhostHandoffStore } = await import('../../cindy-brain/handoffStore.js');
  const { createPluginFileAccess } = await import('../pluginFileAccess.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-handoff-page-'));
  try {
    const store = new GhostHandoffStore({ root: () => root });
    const [own, deleted] = await store.import('plugin', [
      { name: 'a.csv', bytes: new TextEncoder().encode('a,b') },
      { name: 'gone.csv', bytes: new TextEncoder().encode('x') },
    ], () => {});
    const [foreign] = await store.import('other', [{ name: 'b.csv', bytes: new TextEncoder().encode('y') }], () => {});
    await store.delete('plugin', deleted!.ref);
    const access = createPluginFileAccess({ libraryPath: async () => null, libraryMime: () => 'application/octet-stream',
      openHandoff: (instance, ref) => store.openForPage(instance, ref) });
    const files = new PluginAppFiles('card', 'plugin', access, async () => {});
    const link = (file: typeof own) => ({ type: 'resource_link', name: file!.name, uri: file!.ref, mimeType: file!.mimeType, size: file!.size });
    const [signed, missing, other] = await files.project([link(own), link(deleted), link(foreign)]) as Array<{ _meta?: { 'cindy/file': { url: string } } }>;
    expect(missing).toEqual(link(deleted));
    expect(other).toEqual(link(foreign));
    const url = signed!._meta!['cindy/file'].url;
    expect(await (await files.read(url.split('/').pop()!, new Request(url))).text()).toBe('a,b');
    // Handoff links expire by design, so a result echoing one never blocks the card;
    // other unavailable links (Library, media) keep the strict rejection.
    expect(await files.project({ content: [link(deleted)] })).toEqual({ content: [link(deleted)] });
    // An echoed link that carried an earlier URL loses it once the copy is gone.
    expect(await files.project([{ ...link(deleted), _meta: { 'cindy/file': { url: 'stale' }, note: 1 } }]))
      .toEqual([{ ...link(deleted), _meta: { note: 1 } }]);
    await expect(files.project([{ type: 'resource_link', name: 'x', uri: 'library:missing.csv' }])).rejects.toThrow('MCP_APP_FILE_NOT_AUTHORIZED');
    files.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Sliding expiry (product decision): a copy in use stays; only 7 days without a
// link issued or a page read deletes it. Settings listing is not use. Unit tier,
// real store with an injected clock + the real page file path.
it('renews handoff copies on page use and drops the link after 7 unused days', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { GhostHandoffStore } = await import('../../cindy-brain/handoffStore.js');
  const { createPluginFileAccess } = await import('../pluginFileAccess.js');
  const day = 24 * 60 * 60_000;
  const clock = { now: 0 };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-handoff-renew-'));
  try {
    const store = new GhostHandoffStore({ root: () => root, now: () => clock.now });
    const [used, idle] = await store.import('plugin', [
      { name: 'used.csv', bytes: new TextEncoder().encode('a,b') },
      { name: 'idle.csv', bytes: new TextEncoder().encode('x') },
    ], () => {});
    const access = createPluginFileAccess({ libraryPath: async () => null, libraryMime: () => 'application/octet-stream',
      openHandoff: (instance, ref) => store.openForPage(instance, ref) });
    const files = new PluginAppFiles('card', 'plugin', access, async () => {});
    const link = (file: typeof used) => ({ type: 'resource_link', name: file!.name, uri: file!.ref, mimeType: file!.mimeType, size: file!.size });
    const signedUrl = async (file: typeof used) =>
      ((await files.project([link(file)])) as Array<{ _meta?: { 'cindy/file': { url: string } } }>)[0]!._meta?.['cindy/file'].url;

    clock.now = 6 * day;
    expect(await signedUrl(used)).toBeTypeOf('string');
    const expiry = async () => Object.fromEntries((await store.list('plugin')).map((file) => [file.name, file.expiresAt]));
    expect(await expiry()).toEqual({ 'used.csv': 13 * day, 'idle.csv': 7 * day });

    clock.now = 7 * day;
    expect(await signedUrl(idle)).toBeUndefined();
    clock.now = 12 * day;
    const url = (await signedUrl(used))!;
    expect(await (await files.read(url.split('/').pop()!, new Request(url))).text()).toBe('a,b');
    expect(await expiry()).toEqual({ 'used.csv': 19 * day });
    files.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// PR #7924 legacy compatibility: business content arrays are not MCP blocks.
// Unit through the production adapter + real SDK transport; earlier fixtures
// only returned standard text blocks, so malformed wire results went unnoticed.
const legacyBusinessResult = { content: [{ id: 1 }], count: 1 };
const standardPageResult = { content: [{ type: 'text', text: 'public' }], _meta: { page: 'private' } };
it.each([
  { business: legacyBusinessResult, expected: { content: [{ type: 'text', text: JSON.stringify(legacyBusinessResult) }] } },
  { business: standardPageResult, expected: standardPageResult },
])(
  'preserves business JSON or standard page metadata through the page tool transport: %j', async ({ business, expected }) => {
    const client = new Client({ name: 'legacy-page', version: '1' }); clients.push(client);
    await client.connect(createPluginAppTransport({ instance: 'demo', revision: 'v1', tools, ui, hosts: ['api.example.com'],
      assertCurrent() {}, readHtml: () => '<html></html>', call: async () => pluginAppResult(business) }));
    const grant: PluginPageCall = { instance: 'demo', revision: 'v1', tool: 'save', sessionId: 'task', clientId: 'card', assertCurrent: async () => {} };
    const result = await withPluginPageTicket(grant, ticket => client.callTool({ name: 'save', _meta: { [PLUGIN_PAGE_TICKET]: ticket } }));
    expect(result).toEqual(expected);
  },
);
