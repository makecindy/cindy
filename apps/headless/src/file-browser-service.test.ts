import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessConfigStore } from './config.js';
import { HeadlessFileBrowserService } from './file-browser-service.js';
import { HeadlessSessionStorage } from './session-storage.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessFileBrowserService', () => {
  it('serves only user-granted workdir roots and keeps traversal inside the workdir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-files-'));
    dirs.push(dir);
    const workdir = path.join(dir, 'project');
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, 'readme.txt'), 'hello Linux');
    fs.writeFileSync(path.join(dir, 'private.txt'), 'do not leak');
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const base = await config.read();
    await config.write({ ...base, workdirRoots: [workdir] });
    const sessions = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const files = new HeadlessFileBrowserService(config, sessions);

    await expect(files.remoteOp({ op: 'listDir', workdir })).resolves.toEqual([
      expect.objectContaining({ name: 'readme.txt', type: 'file' }),
    ]);
    await expect(files.remoteOp({ op: 'readFile', workdir, relPath: 'readme.txt' }))
      .resolves.toMatchObject({ ok: true, data: { content: 'hello Linux' } });
    await expect(files.remoteOp({ op: 'readFile', workdir, relPath: '../private.txt' }))
      .resolves.toMatchObject({ ok: false, code: 'READ_FAILED' });
    await expect(files.remoteOp({ op: 'listDir', workdir: dir })).rejects.toThrow('workdir not allowed');
    await expect(files.preview(path.join(workdir, 'readme.txt'))).resolves.toMatchObject({ ok: true });
    await expect(files.preview(path.join(dir, 'private.txt'))).resolves.toEqual({ ok: false, code: 'FORBIDDEN' });
    sessions.close();
  });

  it('uses the same aggregate operation shapes as the mobile file browser', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-files-'));
    dirs.push(dir);
    const workdir = path.join(dir, 'project');
    fs.mkdirSync(workdir);
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const base = await config.read();
    await config.write({ ...base, workdirRoots: [workdir] });
    const sessions = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const files = new HeadlessFileBrowserService(config, sessions);

    await expect(files.remoteOp({ op: 'createFile', workdir, relPath: 'note.txt' }))
      .resolves.toMatchObject({ ok: true });
    await expect(files.remoteOp({ op: 'writeFile', workdir, relPath: 'note.txt', content: 'saved' }))
      .resolves.toMatchObject({ ok: true });
    await expect(files.remoteOp({ op: 'renameEntry', workdir, fromRel: 'note.txt', toRel: 'renamed.txt' }))
      .resolves.toMatchObject({ ok: true, stat: { relPath: 'renamed.txt' } });
    await expect(files.remoteOp({ op: 'deleteEntry', workdir, relPath: 'renamed.txt' }))
      .resolves.toEqual({ ok: true });
    sessions.close();
  });

  it('adapts the legacy mobile project-picker filesystem channels without widening roots', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-files-'));
    dirs.push(dir);
    const workdir = path.join(dir, 'project');
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, 'readme.txt'), 'hello Linux');
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const base = await config.read();
    await config.write({ ...base, workdirRoots: [workdir] });
    const sessions = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const files = new HeadlessFileBrowserService(config, sessions);

    await expect(files.listLegacyDirectory(workdir)).resolves.toMatchObject({
      resolvedPath: workdir,
      entries: [expect.objectContaining({ name: 'readme.txt', kind: 'file' })],
      parent: null,
    });
    await expect(files.statLegacyPath(path.join(workdir, 'new-folder')))
      .resolves.toEqual({ kind: 'missing', resolvedPath: path.join(workdir, 'new-folder') });
    await expect(files.mkdirLegacyPath(path.join(workdir, 'new-folder', 'child')))
      .resolves.toEqual({ resolvedPath: path.join(workdir, 'new-folder', 'child') });
    await expect(files.listLegacyDirectory(dir)).rejects.toThrow('outside an allowed remote project root');
    sessions.close();
  });

  it('expands the mobile picker home shorthand without widening its approved root', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-home-'));
    dirs.push(home);
    const project = path.join(home, 'project');
    fs.mkdirSync(project);
    const config = new HeadlessConfigStore(path.join(home, 'config.json'));
    const base = await config.read();
    await config.write({ ...base, workdirRoots: [home] });
    const sessions = new HeadlessSessionStorage(path.join(home, 'sessions.db'));
    const files = new HeadlessFileBrowserService(config, sessions);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(files.listLegacyDirectory('~')).resolves.toMatchObject({
        resolvedPath: home,
        entries: expect.arrayContaining([expect.objectContaining({ name: 'project', kind: 'dir' })]),
      });
      await expect(files.statLegacyPath('~/project')).resolves.toEqual({ kind: 'dir', resolvedPath: project });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      sessions.close();
    }
  });
});
