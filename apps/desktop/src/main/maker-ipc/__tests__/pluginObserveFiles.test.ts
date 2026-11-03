import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginObserveFiles, type ObserveFileSource } from '../pluginObserveFiles.js';

// Unit: public list/open contract, real temporary files. Existing observe tests
// cover visibility, not final-answer provenance, opaque IDs or file boundaries.
// Rule: plugin-security-and-authoring (no implicit file grant). Minimal failures:
// a commentary link, another scope's ID, or a symlink replacing a listed file.
let root: string;
let source: ObserveFileSource;
let service: PluginObserveFiles;
let open: ReturnType<typeof vi.fn>;
const guard = () => {};
const final = (content: string, id = 'm') => ({ id, content, agentMeta: JSON.stringify({ turnCompleted: true }), createdAt: 10 });
const list = () => service.list('project', 'task', 'owner/plugin/revision', guard);
const openFile = (fileId: string, scope = 'owner/plugin/revision') => service.open('project', 'task', fileId, scope, guard);

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'observe-files-')));
  await fs.writeFile(path.join(root, 'report.md'), 'result');
  source = { root, identity: 'root-generation', rows: [final('[Report](report.md)')], partial: false, assertCurrent: async () => {} };
  open = vi.fn();
  service = new PluginObserveFiles({ read: async () => source, open });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('returns only explicit final-answer file references without paths or message content', async () => {
  const fence = String.fromCharCode(96).repeat(3);
  source.rows = [final('[Report](report.md)\n\n' + fence + '\n[example](example.md)\n' + fence + '\n[Web](https://example.com)\nplain.md'),
    { ...final('[Progress](progress.md)', 'progress'), agentMeta: '{}' },
    { ...final('[Narration](narration.md)', 'commentary'), agentMeta: JSON.stringify({ turnCompleted: true, assistantPhase: 'commentary' }) }];
  const result = await list();
  expect(result).toEqual({ partial: false, files: [{ fileId: expect.stringMatching(/^[a-f0-9]{64}$/), name: 'report.md', referencedAt: 10, source: 'final-answer-link', status: 'available' }] });
  expect(JSON.stringify(result)).not.toContain(root);
  await openFile(result.files[0]!.fileId);
  expect(open).toHaveBeenCalledWith('task', 'report.md', expect.any(Function));
});

it('rejects IDs from another plugin, owner, revision, task or project, and stale source records', async () => {
  const id = (await list()).files[0]!.fileId;
  await expect(openFile(id, 'other-scope')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(service.open('project', 'other-task', id, 'owner/plugin/revision', guard)).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(service.open('other-project', 'task', id, 'owner/plugin/revision', guard)).rejects.toThrow('TARGET_UNAVAILABLE');
  source.rows = [final('[Changed](report.md)')];
  await expect(openFile(id)).rejects.toThrow('TARGET_UNAVAILABLE');
  source.rows = [];
  await expect(openFile(id)).rejects.toThrow('TARGET_UNAVAILABLE');
  expect(open).not.toHaveBeenCalled();
});

it('reports missing, unsupported, remote and blocked references without reading arbitrary files', async () => {
  source.rows = [final('[missing](gone.pdf) [secret](.env) [escape](../outside.md) [remote](file://server/report.pdf) [media](cindy-media://blobs/abc.png)')];
  expect((await list()).files.map(file => file.status)).toEqual(['missing', 'blocked', 'blocked', 'not-local', 'unsupported']);
  source.root = null;
  source.rows = [final('[Report](report.md)')];
  expect((await list()).files[0]?.status).toBe('missing');
});

it('refuses deleted files and linked replacements after listing', async (context) => {
  const id = (await list()).files[0]!.fileId;
  await fs.unlink(path.join(root, 'report.md'));
  await expect(openFile(id)).rejects.toThrow('TARGET_UNAVAILABLE');
  await fs.writeFile(path.join(root, 'target.md'), 'not the referenced file');
  try { await fs.symlink(path.join(root, 'target.md'), path.join(root, 'report.md')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
  expect((await list()).files[0]?.status).toBe('blocked');
  await expect(openFile(id)).rejects.toThrow('TARGET_UNAVAILABLE');
  expect(open).not.toHaveBeenCalled();
});

it('refuses intermediate links and multiply linked regular files', async (context) => {
  await fs.mkdir(path.join(root, 'real'));
  await fs.writeFile(path.join(root, 'real', 'nested.md'), 'file');
  try { await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'), 'junction'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
  await fs.link(path.join(root, 'report.md'), path.join(root, 'hard.md'));
  source.rows = [final('[nested](alias/nested.md) [hard](hard.md)')];
  expect((await list()).files.map(file => file.status)).toEqual(['blocked', 'blocked']);
});

it('discards results and never opens after visibility or authorization is revoked', async () => {
  const id = (await list()).files[0]!.fileId;
  source.assertCurrent = async () => { throw new Error('TARGET_UNAVAILABLE'); };
  await expect(list()).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(openFile(id)).rejects.toThrow('TARGET_UNAVAILABLE');
  source.assertCurrent = async () => {};
  await expect(service.open('project', 'task', id, 'owner/plugin/revision', () => { throw new Error('PERMISSION_DENIED'); })).rejects.toThrow('PERMISSION_DENIED');
  expect(open).not.toHaveBeenCalled();
});

it('marks bounded history, oversized replies and excess links as partial', async () => {
  source.partial = true;
  expect((await list()).partial).toBe(true);
  source.partial = false;
  source.rows = [final('x'.repeat(128001))];
  expect(await list()).toEqual({ files: [], partial: true });
  source.rows = [final(Array.from({ length: 101 }, (_, i) => '[file](missing' + i + '.pdf)').join(' '))];
  const result = await list();
  expect(result.partial).toBe(true);
  expect(result.files).toHaveLength(100);
});
