import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const h = vi.hoisted(() => ({ root: '/fixture', lookup: vi.fn(async () => [{ botId: 'fixture-bot' }]) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'fixture-owner', isAppSessionBoundaryPending: () => false, ownerScopedUserDataPath: () => h.root }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ botEnvironmentSecretIo: {} }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => {
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: h.lookup };
  return { drizzle: { select: () => query } };
} }));
import { companionEnvironmentStore, finishCompanionEnvironmentRemoval, readCompanionSessionEnvironment, readCompanionSessionScope, resolveCompanionRuntimeEnvironment } from '../runtime.js';
import { withImportedConnection } from '../connections.js';
import { projectEnvironmentDiscovery } from '../environmentJson.js';
afterEach(() => vi.restoreAllMocks());

it('projects only opaque identity and owner fencing into all harnesses, never imported values', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'fixture-token', GITHUB_PAT: 'fixture-pat', DATABASE_URL: 'postgres://fixture:secret@example.invalid/db',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: fixture-header', ANTHROPIC_UNIX_SOCKET: '/fixture/socket', UNUSUAL_NAME: 'short' };
  const archive = vi.spyOn(companionEnvironmentStore, 'read').mockRejectedValue(new Error('must not load archive'));
  vi.spyOn(companionEnvironmentStore, 'readDiscovery').mockResolvedValue(projectEnvironmentDiscovery({ version: 1, env, mcp: [], credentials: [] }));
  const result = await resolveCompanionRuntimeEnvironment('fixture-session');
  expect(result).toEqual({ identity: expect.any(String), assertCurrent: expect.any(Function) });
  for (const value of Object.values(env)) expect(JSON.stringify(result)).not.toContain(value);
  result!.assertCurrent();
  expect(archive).not.toHaveBeenCalled();
});

it('drains deleted companion transports before vault removal and rejects stale scopes without affecting another companion', async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-delete-connections-'));
  const file = path.join(h.root, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); if (!('id' in r) || r.params?.name === 'hold') return;
 const result=r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : {content:[{type:'text',text:JSON.stringify({pid:process.pid,authenticated:process.env.TOKEN === 'fixture-private-token'})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  vi.spyOn(companionEnvironmentStore, 'read').mockResolvedValue({ version: 1, env: { TOKEN: 'fixture-private-token' }, mcp: [], credentials: [] });
  const scopeFor = async (botId: string) => {
    h.lookup.mockResolvedValueOnce([{ botId }]);
    return (await readCompanionSessionEnvironment(`${botId}-session`))!;
  };
  const deleted = await scopeFor('deleted'); const healthy = await scopeFor('healthy');
  const pids: number[] = [];
  const cleanup = vi.spyOn(companionEnvironmentStore, 'finishRemoval').mockImplementation(async () => {
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
  const server = (name: string) => ({ name, command: process.execPath, args: [file, name] });
  const call = (scope: typeof deleted, name: string, hold = false) => withImportedConnection(server(name), scope.environment.env, scope.assertOwner, async client => {
    const result = await client.callTool({ name: 'identity', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(data.authenticated).toBe(true);
    if (scope === deleted) pids.push(data.pid);
    return hold ? client.callTool({ name: 'hold', arguments: {} }) : data.pid as number;
  }, { identity: scope.identity, signal: new AbortController().signal });
  let pending: Promise<unknown>[] = [];
  try {
    await call(deleted, 'idle');
    const healthyPid = await call(healthy, 'idle');
    // One cached in-flight client and one uncached parallel client.
    pending = [call(deleted, 'running', true), call(deleted, 'running', true)];
    const settled = Promise.allSettled(pending);
    await vi.waitFor(() => expect(pids).toHaveLength(3), { timeout: 5000 });
    // Failure to remove the vault still cannot revive deleted credential holders.
    cleanup.mockImplementationOnce(async () => {
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      throw new Error('fixture vault busy');
    });
    await expect(finishCompanionEnvironmentRemoval(h.root, 'deleted', () => {})).rejects.toThrow('fixture vault busy');
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    expect(() => deleted.assertOwner()).toThrow('COMPANION_DELETED');
    await expect(call(deleted, 'idle')).rejects.toThrow('COMPANION_DELETED');
    // Simulate a DB lookup started before deletion returning its old row late.
    await expect(scopeFor('deleted')).rejects.toThrow('COMPANION_DELETED');
    expect(await call(healthy, 'idle')).toBe(healthyPid);
    await finishCompanionEnvironmentRemoval(h.root, 'deleted', () => {});
  } finally {
    await finishCompanionEnvironmentRemoval(h.root, 'deleted', () => {}).catch(() => {});
    await finishCompanionEnvironmentRemoval(h.root, 'healthy', () => {}).catch(() => {});
    await Promise.allSettled(pending);
    await fs.rm(h.root, { recursive: true, force: true }); h.root = '/fixture';
  }
});

it('resolves the active session owner and deletion fence without reading encrypted content', async () => {
  const read = vi.spyOn(companionEnvironmentStore, 'read').mockRejectedValue(new Error('vault unavailable'));
  const scope = await readCompanionSessionScope('fixture-session');
  expect(scope).toMatchObject({ owner: 'fixture-owner', userData: '/fixture', botId: 'fixture-bot' });
  scope!.assertOwner();
  h.lookup.mockResolvedValueOnce([]);
  expect(await readCompanionSessionScope('unlinked-session')).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
