import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { resolvePluginWorkerDirectory } from '../pluginWorkerDirectory.js';
import { PluginTaskError } from '../pluginTaskService.js';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const start = source.indexOf('      createSession: async (pluginId, taskId, title, route, isolatedWorkspace, requestedRoute, onPersistenceStarted) => {');
const branch = source.slice(start, source.indexOf('      readSession:', start)).trim().replace(/,$/, '');
const js = ts.transpileModule(`return ({ ${branch} }).createSession;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'plugin-create-directory-')));
  roots.push(root);
  const selected = path.join(root, 'selected');
  await mkdir(selected);
  return { root, selected };
}
function fixture(workingDir?: string, afterResolve?: () => void) {
  const snapshot = {};
  let owner = snapshot;
  let authorized = true;
  const cfg = { workingDir, permissionMode: 'plan' };
  const create = vi.fn(async (_args: { shouldContinue: () => boolean; onPersistenceStarted: () => void }) => 'task');
  const onPersistenceStarted = vi.fn();
  const resolve = vi.fn(async (input: Parameters<typeof resolvePluginWorkerDirectory>[0]) => {
    const result = await resolvePluginWorkerDirectory(input);
    afterResolve?.();
    return result;
  });
  const deps = {
    snapshot, PluginTaskError,
    resolveRoute: async () => ({}),
    assertPlugin: () => { if (owner !== snapshot || !authorized) throw new PluginTaskError('PERMISSION_DENIED', 'Owner changed'); },
    readGhostErrandConfig: () => ({ ...cfg }),
    resolvePluginWorkerDirectory: resolve,
    createGhostErrandSession: create,
    clampErrandPermissionMode: (mode: string) => mode,
    getCurrentDbClientSnapshot: () => owner,
    isPluginTaskAuthorized: () => authorized,
    notifyGhostSessionEvent: vi.fn(), broadcastSessionCreated: vi.fn(),
  };
  const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
  return { cfg, create, resolve, onPersistenceStarted, switchOwner: () => { owner = {}; }, revoke: () => { authorized = false; }, run: (isolated = false) => run('plugin', 'task', 'title', {}, isolated, undefined, onPersistenceStarted) };
}
describe('ordinary plugin task configured-directory admission', () => {
  it('creates in the unchanged real directory', async () => {
    const { selected } = await directory();
    const f = fixture(selected);
    await f.run();
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ workingDir: selected }));
    expect(f.create.mock.calls[0][0].onPersistenceStarted).toBe(f.onPersistenceStarted);
    expect(f.onPersistenceStarted).not.toHaveBeenCalled();
  });
  it('rejects a saved root replaced by a link before any creator side effects', async () => {
    const { root, selected } = await directory();
    await rename(selected, path.join(root, 'original'));
    const other = path.join(root, 'other');
    await mkdir(other);
    await symlink(other, selected, 'junction');
    const f = fixture(selected);
    await expect(f.run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([true, false])('keeps managed directory creation without resolving a project root (isolated=%s)', async isolated => {
    const f = fixture(isolated ? '/missing-project' : undefined);
    await f.run(isolated);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.create.mock.calls[0][0]).not.toHaveProperty('workingDir');
  });
  it.each(['directory', 'permission', 'account', 'revocation'])('rejects %s changes after async resolution', async change => {
    const { selected } = await directory();
    const f = fixture(selected, () => {
      if (change === 'directory') f.cfg.workingDir = '/changed';
      if (change === 'permission') f.cfg.permissionMode = 'auto';
      if (change === 'account') f.switchOwner();
      if (change === 'revocation') f.revoke();
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('keeps configuration checks in the creator continuation predicate', async () => {
    const { selected } = await directory();
    const f = fixture(selected);
    await f.run();
    const check = f.create.mock.calls[0][0].shouldContinue;
    expect(check()).toBe(true);
    f.cfg.workingDir = '/changed';
    expect(check()).toBe(false);
  });
});
