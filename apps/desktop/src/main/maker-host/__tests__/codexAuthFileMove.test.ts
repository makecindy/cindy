import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
import { moveCodexAuthFile } from '../codex-auth-file-move';

// Unit tier, CI #10588: the real move integration cannot deterministically stop
// PowerShell before/after File.Move. Drive that process boundary here, retaining
// real isolated filesystem state and asserting publication/no-overwrite results.
let root: string;
let source: string;
let destination: string;
const timeout = () =>
  Object.assign(new Error('private child command'), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
  });

function child(action: () => Promise<void>) {
  execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
    void action().then(
      () => callback(null, '', ''),
      (error) => callback(error, '', ''),
    );
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-move-unit-'));
  source = path.join(root, 'auth.copytmp');
  destination = path.join(root, 'auth.json');
  await fs.writeFile(source, 'fake-original-token');
  execFileMock.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('moveCodexAuthFile interrupted publication', () => {
  it('retries one terminated child when the original source and absent target are verified', async () => {
    child(async () => {
      throw timeout();
    });
    child(async () => {
      await fs.rename(source, destination);
    });
    await moveCodexAuthFile(source, destination);
    expect(await fs.readFile(destination, 'utf8')).toBe('fake-original-token');
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the second timeout without leaking child details or losing the source', async () => {
    child(async () => {
      throw timeout();
    });
    child(async () => {
      throw timeout();
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: 'Codex auth move failed (ETIMEDOUT)',
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(source, 'utf8')).toBe('fake-original-token');
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recognizes a completed move even when its child acknowledgement is lost', async () => {
    child(async () => {
      await fs.rename(source, destination);
      throw timeout();
    });
    await moveCodexAuthFile(source, destination);
    expect(await fs.readFile(destination, 'utf8')).toBe('fake-original-token');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  // Credential storage contract: publication consumes the link itself, not its
  // referent. Ordinary-file fixtures cannot distinguish two links to one file.
  // Model both stat APIs so this unit regression also runs without Windows
  // symlink privileges; real File.Move/symlink behavior has an integration tier.
  it.each([true, false])(
    'accepts a lost symlink move acknowledgement only for the original link (same link: %s)',
    async (sameLink) => {
      const shared = path.join(root, 'shared-auth.json');
      await fs.rename(source, shared);
      const referent = await fs.stat(shared, { bigint: true });
      const originalLink = referent.ino + 1n;
      const links = new Map([[source, originalLink]]);
      const linkIdentity = (file: unknown) => {
        const ino = links.get(String(file));
        if (ino === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return ino;
      };
      vi.spyOn(fs, 'lstat').mockImplementation((async (file) => ({
        ...referent,
        ino: linkIdentity(file),
      })) as typeof fs.lstat);
      vi.spyOn(fs, 'stat').mockImplementation((async (file) => {
        linkIdentity(file);
        return referent;
      }) as typeof fs.stat);
      child(async () => {
        links.delete(source);
        // Both links resolve to exactly the same file, but only one is ours.
        links.set(destination, sameLink ? originalLink : originalLink + 1n);
        throw timeout();
      });
      const result = moveCodexAuthFile(source, destination);
      if (sameLink) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(links.has(source)).toBe(false);
      expect(links.get(destination)).toBe(sameLink ? originalLink : originalLink + 1n);
      expect(await fs.readFile(shared, 'utf8')).toBe('fake-original-token');
    },
  );

  it('preserves a concurrently published destination instead of retrying', async () => {
    child(async () => {
      await fs.writeFile(destination, 'fake-concurrent-token');
      throw timeout();
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(destination, 'utf8')).toBe('fake-concurrent-token');
    expect(await fs.readFile(source, 'utf8')).toBe('fake-original-token');
  });

  it('does not retry a staging path replaced with a different file', async () => {
    child(async () => {
      await fs.rename(source, path.join(root, 'original'));
      await fs.writeFile(source, 'fake-replacement-token');
      throw timeout();
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(source, 'utf8')).toBe('fake-replacement-token');
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not retry an unknown child failure', async () => {
    child(async () => {
      throw new Error('private child command');
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({
      code: 'EIO',
      message: 'Codex auth move failed (EIO)',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(source, 'utf8')).toBe('fake-original-token');
  });

  it('does not retry if the same staging inode was modified', async () => {
    child(async () => {
      await fs.writeFile(source, 'fake-modified-token-with-different-size');
      throw timeout();
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(source, 'utf8')).toBe('fake-modified-token-with-different-size');
  });

  it('does not mistake an unreadable destination for an absent destination', async () => {
    child(async () => {
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, 'lstat').mockImplementation((async (file, options) => {
        if (file === destination) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return lstat(file, options);
      }) as typeof fs.lstat);
      throw timeout();
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(source, 'utf8')).toBe('fake-original-token');
  });

  it('preserves a winner appearing after retry checks through the no-overwrite child operation', async () => {
    child(async () => {
      throw timeout();
    });
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      void fs.writeFile(destination, 'fake-late-winner').then(() => {
        callback(
          Object.assign(new Error('private child command'), { code: 1, stderr: '183' }),
          '',
          '183',
        );
      });
    });
    await expect(moveCodexAuthFile(source, destination)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(destination, 'utf8')).toBe('fake-late-winner');
    expect(await fs.readFile(source, 'utf8')).toBe('fake-original-token');
  });
});
