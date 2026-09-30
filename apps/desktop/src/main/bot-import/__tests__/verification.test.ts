import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: vi.fn() }));
vi.mock('../../localDb/ipc/bots.js', () => ({ getBotRemoteResourceSource: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: { read: vi.fn() } }));
vi.mock('../../maker-host/session-storage.js', () => ({ desktopSessionStorage: { getStatus: vi.fn(async () => 'active') } }));
import { getMakerIfReady } from '../../maker-host/index.js';
import { getBotRemoteResourceSource } from '../../localDb/ipc/bots.js';
import { companionEnvironmentStore } from '../runtime.js';
import { matchesReadEvidence, readImportHttpEvidence, verifyImportedAutomation } from '../verification.js';
import { indexAutomationDependencies, normalizeAutomation } from '../sourceAutomations.js';
import { resolveImportEnvironmentDependencies } from '../environmentSelection.js';
import type { ImportItem, ImportSource } from '../types.js';
import * as connectionModule from '../connections.js';
import { setImportProbeConfirmation } from '../probeAuthorization.js';
import { transferCompanion, type ImportReceipt } from '../transfer.js';
const confirmProbe = vi.fn(async () => ({ kind: 'permission' as const, behavior: 'allow' as const }));
beforeEach(() => { confirmProbe.mockReset().mockResolvedValue({ kind: 'permission', behavior: 'allow' }); setImportProbeConfirmation(confirmProbe); });
let server: Server | undefined;
afterEach(async () => { vi.unstubAllGlobals(); if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); }); server = undefined; });
it('checks actual authenticated response data and refuses redirects/error envelopes', async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/data' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.headers.authorization === 'Bearer fixture-key' ? { result: { rows: [{ count: 7 }] } } : { error: 'unauthorized' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const data = await readImportHttpEvidence(new URL('/data', base), { Authorization: 'Bearer fixture-key' });
  expect(matchesReadEvidence(data, '/result/rows', undefined, true)).toBe(true);
  const denied = await readImportHttpEvidence(new URL('/data', base), {});
  expect(matchesReadEvidence(denied, '', ['error'], false)).toBe(false);
  expect(matchesReadEvidence(data, '/missing', undefined, true)).toBe(false);
  await expect(readImportHttpEvidence(new URL('/redirect', base), {})).rejects.toThrow();
});

it.each(['http', 'monitor'])('requires permission before a credential-bearing %s probe sends any network request', async kind => {
  const env = { DATA_URL: 'https://example.invalid', DATA_TOKEN: 'fixture-private-token' };
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env, mcp: [], credentials: [] });
  const fetch = vi.fn(async () => kind === 'http' ? Response.json({ rows: [] }) : new Response('healthy'));
  vi.stubGlobal('fetch', fetch);
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify(kind === 'monitor' ? { localReminder: true, reads: [] } : { reads: [{ kind: 'http', baseVariable: 'DATA_URL', path: '/data', headers: { Authorization: { variable: 'DATA_TOKEN', prefix: 'Bearer ' } }, pointer: '/rows', array: true }] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ permissionMode: 'ask', agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'job', name: 'Data', category: 'automations', selected: true, ...(kind === 'http' ? { dependsOn: ['env'] } : {}) }, automation: { sourceId: 'job', original: kind === 'monitor' ? { monitor_url: 'https://example.invalid/status?token=fixture-private-token' } : {}, fingerprint: 'fixture' } };
  const selected: ImportItem[] = [{ view: { id: 'env', name: 'env', category: 'connections', selected: true }, env }];
  confirmProbe.mockResolvedValueOnce({ kind: 'permission', behavior: 'deny' } as never);
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(confirmProbe).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(confirmProbe.mock.calls)).toContain('http_get');
  expect(JSON.stringify(confirmProbe.mock.calls)).not.toContain('fixture-private-token');
});

it('verifies a selected skill bundled script using real HTTP without giving the planner its key', async () => {
  let authorized = false;
  server = createServer((req, res) => {
    authorized = req.headers.authorization === 'Bearer fixture-private-token';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(authorized ? { rows: [{ count: 7 }] } : { success: false }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: { DATA_URL: base, DATA_TOKEN: 'fixture-private-token', UNSELECTED_TOKEN: 'unrelated-private-token' }, mcp: [], credentials: [{ id: 'auth', format: 'native-auth', value: { access_token: 'fake-native-access-token' } }] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'DATA_URL', path: '/data', headers: { Authorization: { variable: 'DATA_TOKEN', prefix: 'Bearer ' } }, pointer: '/rows', array: true }] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const skill: ImportItem = { view: { id: 'skill', name: 'dashboard fixture-private-token', category: 'skills', selected: true }, files: [{ name: 'scripts/fake-native-access-token-query.py', bytes: Buffer.from('url = os.environ["DATA_URL"]\ntoken = os.environ["DATA_TOKEN"]\n# private auth: fake-native-access-token'), executable: false }] };
  const result = await verifyImportedAutomation('/fixture', 'bot', {
    view: { id: 'job', name: 'Daily', category: 'automations', selected: true, dependsOn: ['skill'] },
    automation: { sourceId: 'job', original: {}, fingerprint: 'fixture', input: { name: 'Daily', prompt: 'Read dashboard data', enabled: true, triggers: [],  } },
  }, () => {}, [skill]);
  expect(result.verified).toBe(true);
  expect(authorized).toBe(true);
  const prompt = oneShot.mock.calls[0]![1] as string;
  expect(prompt).toContain('scripts/');
  expect(prompt).toContain('-query.py');
  expect(prompt).toContain('DATA_TOKEN');
  expect(prompt).not.toContain('fixture-private-token');
  expect(prompt).not.toContain('fake-native-access-token');
  expect(prompt).not.toContain('UNSELECTED_TOKEN');
  expect(skill.view.name).toBe('dashboard fixture-private-token');
  expect(skill.files![0]!.name).toBe('scripts/fake-native-access-token-query.py');
});

it('keeps HTTP base paths opaque while resolving the exact URL and appended resources privately', async () => {
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url!);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rows: [] }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { DATA_URL: `${origin}/api/fake%2Fpath%2Btoken?key=fake-query-token` };
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env, mcp: [], credentials: [] });
  let suffix = '';
  const oneShot = vi.fn(async (_kind: string, prompt: string) => {
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    const base = context.bases[0];
    expect(base.origin).toBe(origin);
    expect(base.pathname).not.toContain('fake');
    expect(prompt).not.toContain('fake%2Fpath%2Btoken');
    expect(prompt).not.toContain('fake/path+token');
    expect(prompt).not.toContain('fake-query-token');
    return JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'DATA_URL', path: `${base.pathname}${suffix}`, pointer: '/rows', array: true }] });
  });
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'job', name: 'Read', category: 'automations', selected: true, dependsOn: ['env'] }, automation: { sourceId: 'job', original: {}, fingerprint: 'fixture' } };
  const selected: ImportItem[] = [{ view: { id: 'env', name: 'env', category: 'connections', selected: true }, env }];
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  suffix = '/rows';
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  expect(paths).toEqual(['/api/fake%2Fpath%2Btoken?key=fake-query-token', '/api/fake%2Fpath%2Btoken/rows']);
  const approvals = JSON.stringify(confirmProbe.mock.calls);
  for (const secret of ['fake%2Fpath%2Btoken', 'fake/path+token', 'fake-query-token']) expect(approvals).not.toContain(secret);
  expect(env.DATA_URL).toBe(`${origin}/api/fake%2Fpath%2Btoken?key=fake-query-token`);
});

it('rejects a plan that sends an allowed credential to an unrelated allowed origin before fetching', async () => {
  const env = { DATA_URL: 'https://data.example.invalid', DATA_TOKEN: 'fixture-private-token', ATTACKER_URL: 'https://attacker.example.invalid' };
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env, mcp: [], credentials: [] });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'ATTACKER_URL', path: '/collect', headers: { Authorization: { variable: 'DATA_TOKEN', prefix: 'Bearer ' } }, pointer: '/rows', array: true }] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'job', name: 'Read', category: 'automations', selected: true, dependsOn: ['env'] }, automation: { sourceId: 'job', original: {}, fingerprint: 'fixture' } };
  const result = await verifyImportedAutomation('/fixture', 'bot', item, () => {}, [{ view: { id: 'env', name: 'env', category: 'connections', selected: true }, env }]);
  expect(result).toMatchObject({ verified: false, reason: 'AUTOMATION_READ_NOT_VERIFIED' });
  expect(fetch).not.toHaveBeenCalled();
  const prompt = oneShot.mock.calls[0]![1] as string;
  expect(prompt).not.toContain(env.DATA_TOKEN);
  const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  expect(context.variables).toEqual(expect.arrayContaining(['DATA_TOKEN', 'ATTACKER_URL']));
  expect(context.bases.find((base: { variable: string }) => base.variable === 'ATTACKER_URL').authVariables).toEqual([]);
});

it('reads the literal monitor URL, including text bodies, without exposing it or accepting an unrelated query instead', async () => {
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url!.startsWith('/unavailable')) { res.writeHead(503); res.end(); return; }
    if (req.url!.startsWith('/redirect')) { res.writeHead(302, { location: '/other' }); res.end(); return; }
    res.setHeader('content-type', 'text/plain'); res.end('Service status changed');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const monitor = `${origin}/monitor?token=fixture-monitor-secret`;
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp: [], credentials: [] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localReminder: true, reads: [] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'monitor', name: 'Monitor', category: 'automations', selected: true }, automation: { sourceId: 'monitor', original: { monitor_url: monitor }, fingerprint: 'fixture' } };
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {})).verified).toBe(true);
  expect(paths).toEqual(['/monitor?token=fixture-monitor-secret']);
  expect(oneShot.mock.calls[0]![1]).toContain('"monitorVerified":true');
  expect(oneShot.mock.calls[0]![1]).not.toContain(monitor);
  expect(oneShot.mock.calls[0]![1]).not.toContain('fixture-monitor-secret');
  // A model's unrelated successful-read plan cannot bypass a failed exact monitor.
  oneShot.mockClear(); oneShot.mockResolvedValue(JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'OTHER_URL', path: '/other', pointer: '/rows', array: true }] }));
  for (const pathname of ['/unavailable', '/redirect']) {
    item.automation!.original.monitor_url = origin + pathname;
    expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {})).verified).toBe(false);
  }
  expect(paths).toEqual(['/monitor?token=fixture-monitor-secret', '/unavailable', '/redirect']);
  expect(oneShot).not.toHaveBeenCalled();
});

it('rejects an oversized monitor response and cancels its body', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
  await expect(readImportHttpEvidence(new URL('https://monitor.example.invalid'), {}, false)).rejects.toThrow('Query response too large');
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['hermes', 'openclaw'] as const)('routes a %s reminder locally without probing its former Telegram destination', async kind => {
  const token = '12345:fixture-private-token';
  const selected: ImportItem[] = [
    { view: { id: 'token', name: 'TELEGRAM_BOT_TOKEN', category: 'connections', selected: true }, env: { TELEGRAM_BOT_TOKEN: token } },
    { view: { id: 'telegram', name: 'Telegram', category: 'connections', selected: true, dependsOn: ['token'] }, credential: { format: 'telegram', value: { token: '${TELEGRAM_BOT_TOKEN}', account: 'default' } } },
    { view: { id: 'api', name: 'DATA_URL', category: 'connections', selected: true }, env: { DATA_URL: 'https://example.invalid' } },
  ];
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: { TELEGRAM_BOT_TOKEN: token, DATA_URL: 'https://example.invalid' }, mcp: [], credentials: [{ id: 'telegram', format: 'telegram', value: { token, account: 'default' } }] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localReminder: true, reads: [] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const fetch = vi.fn(async (url: string) => {
    const method = new URL(url).pathname.split('/').at(-1);
    const result = method === 'getMe' ? { id: 12345, is_bot: true }
      : method === 'getChat' ? { id: 123, type: 'private' } : undefined;
    expect(result).toBeDefined(); // Never send a test message during takeover.
    return Response.json({ ok: true, result });
  });
  vi.stubGlobal('fetch', fetch);
  const source: ImportSource = { kind, agentId: 'main', name: 'Fixture', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config' };
  const reminder = (prompt: string) => resolveImportEnvironmentDependencies([normalizeAutomation(source, {
    id: 'reminder', name: 'Reminder', prompt, payload: { message: prompt }, schedule: { kind: 'interval', minutes: 5 },
    deliver: 'telegram:123', delivery: { mode: 'announce', channel: 'telegram', to: '123' },
  }, indexAutomationDependencies(selected), 'UTC')], selected)[0]!;
  const item = reminder('Remind me to stretch');
  expect(item.view.dependsOn).toEqual([]);
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(oneShot.mock.calls[0]![1]).not.toContain('TELEGRAM_BOT_TOKEN');
  expect(oneShot.mock.calls[0]![1]).not.toContain(token);
  // A variable also used for data is still required, even if delivery uses it too.
  for (const prompt of ['Read Telegram data using TELEGRAM_BOT_TOKEN', 'Read DATA_URL']) {
    expect((await verifyImportedAutomation('/fixture', 'bot', reminder(prompt), () => {}, selected)).verified).toBe(false);
  }
  // An unavailable former destination does not block local reminders.
  oneShot.mockClear();
  fetch.mockResolvedValue(Response.json({ ok: false }, { status: 403 }));
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('finds a second-page read tool, redacts its catalog before planning and forwards its original identity privately', async () => {
  const token = 'fixture-connection-token';
  const header = 'fixture-header-token';
  const mcp = [{ name: `source_${token}`, url: 'https://example.invalid/mcp/fixture%2Fpath-token', env: { PRIVATE: token }, headers: { Authorization: `Bearer ${header}` } }];
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp, credentials: [] });
  const toolName = `read_${token}`;
  const callTool = vi.fn(async () => ({ structuredContent: { rows: [{ count: 7 }] } }));
  const listTools = vi.fn(async ({ cursor }: { cursor?: string }) => cursor
    ? { tools: [{ name: toolName, description: `${token} ${header} fixture/path-token fixture%2Fpath-token`, inputSchema: { type: 'object', properties: { [token]: { type: 'string', default: header } }, required: [token] }, annotations: { readOnlyHint: true } }] }
    : { tools: [{ name: 'write_data', inputSchema: { type: 'object' } }], nextCursor: 'page-2' });
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({
    listTools, callTool,
  } as never));
  const oneShot = vi.fn(async (_agent, prompt: string) => {
    expect(prompt).not.toContain(token); expect(prompt).not.toContain(header);
    expect(prompt).not.toContain('fixture/path-token'); expect(prompt).not.toContain('fixture%2Fpath-token');
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    const connection = context.connections[0];
    const argument = Object.keys(connection.tools[0].inputSchema.properties)[0]!;
    return JSON.stringify({ reads: [{ kind: 'mcp', connection: connection.name, tool: connection.tools[0].name, arguments: { [argument]: 'daily' }, pointer: '/rows', array: true }] });
  });
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  try {
    const result = await verifyImportedAutomation('/fixture', 'bot', { view: { id: 'query', name: 'Query', category: 'automations', selected: true }, automation: { sourceId: 'query', original: {}, fingerprint: 'fixture' } }, () => {});
    expect(result.verified).toBe(true);
    expect(oneShot).toHaveBeenCalledOnce();
    expect(listTools.mock.calls.map(([args]) => args.cursor)).toEqual([undefined, 'page-2']);
    expect(callTool).toHaveBeenCalledWith({ name: toolName, arguments: { [token]: 'daily' } }, undefined, { timeout: 30000, signal: expect.any(AbortSignal) });
    expect(confirmProbe).toHaveBeenCalledOnce();
    expect(JSON.stringify(confirmProbe.mock.calls)).not.toContain(token);
    expect(JSON.stringify(confirmProbe.mock.calls)).not.toContain(header);
    expect(JSON.stringify(confirmProbe.mock.calls)).not.toContain('fixture/path-token');
    expect(JSON.stringify(confirmProbe.mock.calls)).not.toContain('fixture%2Fpath-token');
    expect(confirmProbe.mock.invocationCallOrder[0]).toBeLessThan(callTool.mock.invocationCallOrder[0]!);
    // A server's readOnlyHint cannot override denial of this exact planned call.
    confirmProbe.mockResolvedValueOnce({ kind: 'permission', behavior: 'deny' } as never);
    expect((await verifyImportedAutomation('/fixture', 'bot', { view: { id: 'query', name: 'Query', category: 'automations', selected: true }, automation: { sourceId: 'query', original: {}, fingerprint: 'fixture' } }, () => {})).verified).toBe(false);
    expect(callTool).toHaveBeenCalledOnce();
  } finally { imported.mockRestore(); }
});

it('isolates failed optional catalogs during takeover, but rejects missing planned tools and propagates owner loss', async () => {
  const mcp = ['stopped', 'paged', 'healthy'].map(name => ({ name, url: `https://${name}.example.invalid/mcp` }));
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp, credentials: [] });
  const callTool = vi.fn(async () => ({ structuredContent: { rows: [1] } }));
  let ownerChanged = false;
  const assertOwner = () => { if (ownerChanged) throw new Error('OWNER_CHANGED'); };
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (server, _env, _assert, run) => {
    if (server.name === 'stopped') throw new Error('Unavailable');
    return run({ listTools: async ({ cursor }: { cursor?: string }) => {
      if (cursor) throw new Error('Incomplete catalog');
      return { tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], ...(server.name === 'paged' ? { nextCursor: 'next' } : {}) };
    }, callTool } as never);
  });
  const oneShot = vi.fn(async (_agent, prompt: string) => {
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    expect(context.connections.map((connection: { name: string }) => connection.name)).toEqual(['healthy']);
    return JSON.stringify({ reads: [{ kind: 'mcp', connection: 'healthy', tool: 'read', arguments: {}, pointer: '/rows', array: true }] });
  });
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'query', name: 'Query', category: 'automations', selected: true }, automation: { sourceId: 'query', original: {}, fingerprint: 'fixture' } };
  try {
    expect((await verifyImportedAutomation('/fixture', 'bot', item, assertOwner)).verified).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    oneShot.mockResolvedValue(JSON.stringify({ reads: [{ kind: 'mcp', connection: 'paged', tool: 'read', pointer: '/rows', array: true }] }));
    expect((await verifyImportedAutomation('/fixture', 'bot', item, assertOwner)).verified).toBe(false);
    expect(callTool).toHaveBeenCalledOnce();
    imported.mockImplementationOnce(async () => { ownerChanged = true; throw new Error('Disconnected'); });
    await expect(verifyImportedAutomation('/fixture', 'bot', item, assertOwner)).rejects.toThrow('OWNER_CHANGED');
  } finally { imported.mockRestore(); }
});

it.each(['unavailable', 'omitted', 'bad-evidence', 'complete'] as const)('requires both skill-referenced MCP sources before pausing the source (%s)', async mode => {
  const servers = ['sales', 'ledger'].map(name => ({ name, url: `https://${name}.example.invalid/mcp`, headers: { Authorization: 'Bearer fixture-shared-key' } }));
  const selected: ImportItem[] = [
    { view: { id: 'key', name: 'SHARED_KEY', category: 'connections', selected: true }, env: { SHARED_KEY: 'fixture-shared-key' } },
    ...servers.map(mcp => ({ view: { id: mcp.name, name: mcp.name, category: 'connections' as const, selected: true, dependsOn: ['key'] }, mcp })),
    { view: { id: 'skill', name: 'Report', category: 'skills', selected: true, dependsOn: ['sales', 'ledger'] }, files: [] },
  ];
  const item: ImportItem = { view: { id: 'job', name: 'Daily', category: 'automations', selected: true, enabled: true, dependsOn: ['skill'] },
    automation: { sourceId: 'job', original: {}, fingerprint: 'fixture', input: { name: 'Daily', prompt: 'Combine sales and ledger', enabled: false, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }] } } };
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: selected[0]!.env!, mcp: servers, credentials: [] });
  const calls: string[] = [];
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (server, _env, _assert, run) => {
    if (server.name === 'ledger' && mode === 'unavailable') throw new Error('Offline');
    return run({ listTools: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }),
      callTool: async () => { calls.push(server.name); return { structuredContent: server.name === 'ledger' && mode === 'bad-evidence' ? { error: 'unavailable' } : { rows: [1] } }; },
    } as never);
  });
  const oneShot = vi.fn(async (_agent, prompt: string) => {
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    expect(context.requiredConnections).toEqual(['sales', 'ledger']);
    expect(prompt).not.toContain('fixture-shared-key');
    return JSON.stringify({ reads: (mode === 'unavailable' || mode === 'omitted' ? ['sales'] : ['sales', 'ledger'])
      .map(connection => ({ kind: 'mcp', connection, tool: 'read', arguments: {}, pointer: '/rows', array: true })),
    // Planner claims are not evidence for the omitted connection.
    coveredDependencies: ['sales', 'ledger', 'SHARED_KEY'] });
  });
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const pause = vi.fn(async () => {}); const enable = vi.fn(async () => {});
  let receipt: ImportReceipt | undefined;
  try {
    const result = await transferCompanion({ source: { kind: 'hermes', agentId: 'main', name: 'Ada', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config' }, items: [...selected, item], fingerprint: 'fixture' },
      { requestId: 'all-evidence-fixture', previewId: 'preview', name: 'Ada', entryIds: [...selected, item].map(entry => entry.view.id), takeover: true }, {
        assertOwner() {}, readReceipt: async () => receipt, saveReceipt: async value => { receipt = structuredClone(value); },
        createCompanion: async () => {}, importItem: async () => {}, saveEnvironment: async () => {}, saveCheckpoint: async () => {},
        createConversation: async () => 'chat', createRoutine: async () => 'routine',
        verifyAutomation: (botId, task) => verifyImportedAutomation('/fixture', botId, task, () => {}, selected),
        pauseSource: pause, resumeSource: async () => {}, enableRoutine: enable,
      });
    expect(result.status).toBe(mode === 'complete' ? 'complete' : 'needs-attention');
    expect(pause).toHaveBeenCalledTimes(mode === 'complete' ? 1 : 0);
    expect(enable).toHaveBeenCalledTimes(mode === 'complete' ? 1 : 0);
    expect(calls).toEqual(mode === 'unavailable' || mode === 'omitted' ? ['sales'] : ['sales', 'ledger']);
  } finally { imported.mockRestore(); }
});

it('requires actual reads for every referenced HTTP base and credential, including dependencies used only in skill files', async () => {
  const hits: string[] = [];
  server = createServer((req, res) => {
    hits.push(req.url!);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows: [1] }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { SALES_URL: `${origin}/sales`, SALES_TOKEN: 'fixture-sales-key', LEDGER_URL: `${origin}/ledger`, LEDGER_TOKEN: 'fixture-ledger-key', REGION: 'us', LANG: 'en' };
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env, mcp: [], credentials: [] });
  const selected: ImportItem[] = [{ view: { id: 'skill', name: 'Report', category: 'skills', selected: true, dependsOn: ['region', 'lang'] }, files: [
    { name: 'scripts/report.py', bytes: Buffer.from(Object.keys(env).map(key => `os.environ['${key}']`).join('\n')), executable: false },
  ] }, { view: { id: 'region', name: 'REGION', category: 'connections', selected: true }, env: { REGION: env.REGION } },
    { view: { id: 'lang', name: 'LANG', category: 'connections', selected: true }, env: { LANG: env.LANG } }];
  const item: ImportItem = { view: { id: 'job', name: 'Daily', category: 'automations', selected: true, dependsOn: ['skill'] }, automation: { sourceId: 'job', original: {}, fingerprint: 'fixture' } };
  const read = (prefix: string, auth = true) => ({ kind: 'http', baseVariable: `${prefix}_URL`, path: `/${prefix.toLowerCase()}`,
    ...(auth ? { headers: { Authorization: { variable: `${prefix}_TOKEN`, prefix: 'Bearer ' } } } : {}), pointer: '/rows', array: true });
  const oneShot = vi.fn();
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  for (const reads of [[read('SALES')], [read('SALES'), read('LEDGER', false)], [read('SALES'), read('LEDGER')]]) {
    oneShot.mockResolvedValue(JSON.stringify({ reads }));
    const result = await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected);
    expect(result.verified).toBe(reads.length === 2 && !!reads[1]!.headers);
  }
  expect(hits).toEqual(['/sales', '/sales', '/ledger', '/sales', '/ledger']);
  const context = JSON.parse((oneShot.mock.calls[0]![1] as string).split('\n').at(-1)!);
  expect(context.requiredVariables).toEqual(['SALES_URL', 'SALES_TOKEN', 'LEDGER_URL', 'LEDGER_TOKEN']);
  // A locale-shaped value used explicitly as auth is still a credential.
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env, credentials: [],
    mcp: [{ name: 'configured', url: `${origin}/mcp`, headers: { 'X-Api-Key': env.LANG } }] });
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [] }) } as never));
  try {
    oneShot.mockResolvedValue(JSON.stringify({ reads: [read('SALES'), read('LEDGER')] }));
    expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(false);
    const sales = read('SALES');
    oneShot.mockResolvedValue(JSON.stringify({ reads: [{ ...sales, headers: { ...sales.headers, 'X-Api-Key': { variable: 'LANG' } } }, read('LEDGER')] }));
    expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  } finally { imported.mockRestore(); }
});

it.skipIf(process.platform === 'win32')('checks a local script without executing it, and refuses invalid or data-dependent scripts', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-local-script-test-'));
  try {
    const marker = path.join(root, 'must-not-be-created');
    const script = '. ./helper.sh\nreport\n';
    const helper = `report() { cat data/input.txt; touch '${marker}'; }\n`;
    const files: Record<string, string> = { 'scripts/local.sh': Buffer.from(script).toString('base64'), 'scripts/helper.sh': Buffer.from(helper).toString('base64'), 'scripts/data/input.txt': Buffer.from('local report data').toString('base64') };
    const environment = { version: 1 as const, env: {}, mcp: [], credentials: [], files };
    vi.mocked(companionEnvironmentStore.read).mockResolvedValue(environment);
    const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localScript: true, reads: [] }));
    vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSession: vi.fn(), getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
    vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
    const item = { view: { id: 'local', name: 'Local report', category: 'automations' as const, selected: true, dependsOn: ['script'] },
      automation: { sourceId: 'local', original: { script: 'local.sh', no_agent: true }, fingerprint: 'fixture' } };
    const selected = [{ view: { id: 'script', name: 'local.sh', category: 'connections' as const, selected: true }, asset: { name: 'scripts/local.sh', bytes: Buffer.from(script) } },
      { view: { id: 'helper', name: 'helper.sh', category: 'connections' as const, selected: true }, asset: { name: 'scripts/helper.sh', bytes: Buffer.from(helper) } },
      { view: { id: 'data', name: 'input.txt', category: 'connections' as const, selected: true }, asset: { name: 'scripts/data/input.txt', bytes: Buffer.from('local report data') } }];
    item.view.dependsOn.push('helper', 'data');
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, selected, root)).verified).toBe(true);
    const prompt = oneShot.mock.calls[0]![1] as string;
    const planInput = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    expect(planInput.scripts.find((file: { name: string }) => file.name === 'scripts/helper.sh').source).toBe(helper);
    expect(planInput.scriptAssets).toContain('scripts/data/input.txt');
    await expect(fs.access(marker)).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'bots/bot/import-executions'))).toEqual([]);
    delete files['scripts/data/input.txt'];
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, selected, root)).verified).toBe(false);
    expect(oneShot).toHaveBeenCalledOnce();
    files['scripts/data/input.txt'] = Buffer.from('local report data').toString('base64');
    files['scripts/helper.sh'] = Buffer.from('x'.repeat(32001)).toString('base64');
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, selected, root)).verified).toBe(false);
    files['scripts/helper.sh'] = Buffer.from(helper).toString('base64');
    environment.files['scripts/local.sh'] = Buffer.from('if then broken').toString('base64');
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, selected, root)).verified).toBe(false);
    environment.files['scripts/local.sh'] = Buffer.from(script).toString('base64');
    item.view.dependsOn.push('api');
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, [...selected, { view: { id: 'api', name: 'API_URL', category: 'connections', selected: true }, env: { API_URL: 'https://example.invalid' } }], root)).verified).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


it('does not verify a native command as a local reminder or expose its inline environment secret to planning', async () => {
  const secret = 'fixture-command-token';
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp: [], credentials: [], contentRedactions: { command_token: secret } });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localReminder: true, reads: [] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const source: ImportSource = { kind: 'openclaw', agentId: 'main', name: 'Fixture', root: '/fixture', workspace: '/fixture/workspace', configFile: '/fixture/openclaw.json' };
  const item = normalizeAutomation(source, { id: 'command', name: 'Report', payload: { kind: 'command', argv: ['report', '--token', secret], env: { API_TOKEN: secret } }, schedule: { kind: 'every', everyMs: 60000 } }, indexAutomationDependencies([]), 'UTC');
  expect(await verifyImportedAutomation('/fixture', 'bot', item, () => {})).toMatchObject({ verified: false, reason: 'AUTOMATION_READ_NOT_VERIFIED' });
  expect(oneShot.mock.calls[0]![1]).toContain('native-command');
  expect(oneShot.mock.calls[0]![1]).not.toContain(secret);
});

it('keeps literals that are absent from all credential maps out of the command read planner', async () => {
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp: [], credentials: [] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ reads: [] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const source: ImportSource = { kind: 'openclaw', agentId: 'main', name: 'Fixture', root: '/fixture', workspace: '/fixture/workspace', configFile: '/fixture/openclaw.json' };
  const item = normalizeAutomation(source, { id: 'command', name: 'Report', payload: { kind: 'command', argv: ['private-executable', '--token', 'argument-only-secret'], cwd: '/private-directory', input: 'stdin-only-secret' }, schedule: { kind: 'every', everyMs: 60000 } }, indexAutomationDependencies([]), 'UTC');
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {})).verified).toBe(false);
  const prompt = oneShot.mock.calls[0]![1];
  for (const literal of ['private-executable', 'argument-only-secret', '/private-directory', 'stdin-only-secret']) expect(prompt).not.toContain(literal);
  expect(prompt).toContain('native-command');
});
