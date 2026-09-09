import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFile: vi.fn(),
  createImage: vi.fn(),
  createMessage: vi.fn(async () => ({ data: { message_id: 'om_sent' } })),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    im = {
      v1: {
        message: { create: mocks.createMessage },
        messageReaction: { create: vi.fn(), delete: vi.fn() },
        image: { create: mocks.createImage },
      },
      file: { create: mocks.createFile },
    };
  },
  Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
}));

vi.mock('../ownerGuard.js', () => ({
  firstAllowed: vi.fn(() => 'ou_owner'),
  check: vi.fn(() => true),
}));

vi.mock('../moduleScope.js', () => ({
  getLog: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import * as outbound from '../outbound.js';

const tempDirs: string[] = [];

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fileFixture(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-'));
  tempDirs.push(root);
  const absPath = path.join(root, name);
  await fs.writeFile(absPath, content);
  return absPath;
}

describe('Feishu parent-chat file reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbound.unbindClient();
    outbound.bindClient({ appId: 'cli_file_test', appSecret: 'secret', service: 'feishu' });
    mocks.createFile.mockImplementation(
      async ({ data }: { data: { file: NodeJS.ReadableStream } }) => {
        await readStream(data.file);
        return { file_key: 'file-key' };
      },
    );
    mocks.createImage.mockImplementation(
      async ({ data }: { data: { image: NodeJS.ReadableStream } }) => {
        await readStream(data.image);
        return { image_key: 'image-key' };
      },
    );
  });

  afterEach(async () => {
    outbound.unbindClient();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('uploads a regular file once and reuses its file_key for the parent chat', async () => {
    const absPath = await fileFixture('报告.txt', 'trusted report');

    const primary = await outbound.sendFile('ou_owner', absPath, 'report.txt');
    expect(primary).toMatchObject({
      ok: true,
      messageId: 'om_sent',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath: expect.any(String),
        dev: expect.any(String),
        ino: expect.any(String),
        ancestors: [],
      },
    });
    if (['linux', 'darwin', 'win32'].includes(process.platform)) {
      expect(primary.uploadedSource!.realPath.length).toBeGreaterThan(0);
    } else {
      expect(primary.uploadedSource!.realPath).toBe('');
    }

    await expect(
      outbound.sendFileToChat('oc_group', primary.reusableMessage!, 'u1'),
    ).resolves.toEqual({ ok: true, messageId: 'om_sent' });

    expect(mocks.createFile).toHaveBeenCalledOnce();
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
  });

  it('proves a Unicode file only through the same pinned directory object chain', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-chain-allowed-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-chain-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);
    const segments = ['子目录', '报告.txt'];
    await Promise.all([
      fs.mkdir(path.join(allowedRoot, segments[0])),
      fs.mkdir(path.join(outsideRoot, segments[0])),
    ]);
    const allowedFile = path.join(allowedRoot, ...segments);
    const outsideFile = path.join(outsideRoot, ...segments);
    await Promise.all([
      fs.writeFile(allowedFile, 'allowed'),
      fs.writeFile(outsideFile, 'outside'),
    ]);

    const rootFd = fsSync.openSync(allowedRoot, fsSync.constants.O_RDONLY);
    const allowedFd = fsSync.openSync(allowedFile, fsSync.constants.O_RDONLY);
    const outsideFd = fsSync.openSync(outsideFile, fsSync.constants.O_RDONLY);
    try {
      await expect(
        outbound.attestOpenFileWithinDirectory(allowedFd, rootFd, segments),
      ).resolves.toBe(true);
      await expect(
        outbound.attestOpenFileWithinDirectory(outsideFd, rootFd, segments),
      ).resolves.toBe(false);
    } finally {
      fsSync.closeSync(outsideFd);
      fsSync.closeSync(allowedFd);
      fsSync.closeSync(rootFd);
    }
  });

  it('rejects a source reached only through an intermediate directory link', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-chain-link-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-chain-secret-'));
    tempDirs.push(allowedRoot, outsideRoot);
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    const linked = path.join(allowedRoot, 'linked');
    try {
      await fs.symlink(outsideRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const rootFd = fsSync.openSync(allowedRoot, fsSync.constants.O_RDONLY);
    const sourceFd = fsSync.openSync(outsideFile, fsSync.constants.O_RDONLY);
    try {
      await expect(
        outbound.attestOpenFileWithinDirectory(sourceFd, rootFd, ['linked', 'secret.txt']),
      ).resolves.toBe(false);
    } finally {
      fsSync.closeSync(sourceFd);
      fsSync.closeSync(rootFd);
    }
  });

  it('uploads an image once and reuses its image_key for the parent chat', async () => {
    const absPath = await fileFixture('preview.png', 'trusted image');

    const primary = await outbound.sendFile('ou_owner', absPath);
    expect(primary.reusableMessage).toEqual({
      msgType: 'image',
      content: JSON.stringify({ image_key: 'image-key' }),
    });

    await expect(
      outbound.sendFileToChat('oc_group', primary.reusableMessage!, 'u2'),
    ).resolves.toEqual({ ok: true, messageId: 'om_sent' });

    expect(mocks.createImage).toHaveBeenCalledOnce();
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
  });

  it('reports a parent-message failure without uploading the local file again', async () => {
    const absPath = await fileFixture('report.txt', 'trusted report');
    const primary = await outbound.sendFile('ou_owner', absPath);
    mocks.createMessage.mockRejectedValueOnce(new Error('group unavailable'));

    await expect(
      outbound.sendFileToChat('oc_group', primary.reusableMessage!, 'u3'),
    ).resolves.toEqual({ ok: false, reason: 'SEND_FAIL' });

    expect(mocks.createFile).toHaveBeenCalledOnce();
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('uploads the inode opened for identity when the path is replaced before the stream starts', async () => {
    const absPath = await fileFixture('report.txt', 'trusted report');
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-outside-'));
    tempDirs.push(outsideRoot);
    const outside = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outside, 'LEAKED SECRET');

    let uploaded = '';
    mocks.createFile.mockImplementation(
      async ({ data }: { data: { file: NodeJS.ReadableStream } }) => {
        uploaded = await readStream(data.file);
        return { file_key: 'file-key' };
      },
    );

    const realCreateReadStream = fsSync.createReadStream;
    const spy = vi.spyOn(fsSync, 'createReadStream').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      if (file === absPath) {
        fsSync.unlinkSync(absPath);
        fsSync.copyFileSync(outside, absPath);
      }
      return realCreateReadStream(
        file as Parameters<typeof realCreateReadStream>[0],
        options as Parameters<typeof realCreateReadStream>[1],
      );
    }) as typeof fsSync.createReadStream);

    try {
      const primary = await outbound.sendFile('ou_owner', absPath, 'report.txt');
      expect(primary.ok).toBe(true);
      expect(uploaded).toBe('trusted report');
      expect(primary.uploadedSource).toMatchObject({
        realPath: expect.any(String),
        dev: expect.any(String),
        ino: expect.any(String),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('does not attest a path-based fallback when the Windows helper is unavailable', async () => {
    const absPath = await fileFixture('report.txt', 'trusted report');
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const realStat = fsSync.statSync.bind(fsSync);
    const stat = vi.spyOn(fsSync, 'statSync').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      if (String(file).toLowerCase().endsWith('\\powershell.exe')) {
        throw new Error('Windows helper unavailable');
      }
      return realStat(
        file as Parameters<typeof realStat>[0],
        options as Parameters<typeof realStat>[1],
      );
    }) as typeof fsSync.statSync);

    try {
      const primary = await outbound.sendFile('ou_owner', absPath, 'report.txt');
      expect(primary.ok).toBe(true);
      expect(primary.uploadedSource).toMatchObject({
        realPath: '',
        dev: expect.any(String),
        ino: expect.any(String),
      });
    } finally {
      stat.mockRestore();
      platform.mockRestore();
    }
  });

  it('keeps Darwin containment independent of Electron RunAsNode', async () => {
    // Windows CI may check out CRLF; the launcher marker below is LF-only.
    const source = (
      await fs.readFile(new URL('../outbound.ts', import.meta.url), 'utf8')
    ).replace(/\r\n/g, '\n');
    const helperStart = source.indexOf('const DARWIN_HANDLE_CONTAINMENT_SCRIPT');
    const helperEnd = source.indexOf('let client:', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const launcherStart = source.indexOf('async function darwinHandleContainment');
    const launcherEnd = source.indexOf('/**\n * Object-chain containment proof', launcherStart);
    const launcher = source.slice(launcherStart, launcherEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(launcherStart).toBeGreaterThanOrEqual(0);
    expect(launcherEnd).toBeGreaterThan(launcherStart);
    expect(helper).toContain('O_NOFOLLOW');
    expect(helper).toContain('SYS_openat');
    expect(helper).not.toContain('/dev/fd/');
    expect(launcher).toContain("'/usr/bin/perl'");
    expect(launcher).not.toContain('process.execPath');
    expect(launcher).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('does not attest the restored in-root path after the opened file is retargeted', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-retarget-in-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-retarget-out-'));
    tempDirs.push(allowedRoot, outsideRoot);
    const secret = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secret, 'LEAKED SECRET');
    const absPath = path.join(allowedRoot, 'report.txt');
    try {
      await fs.symlink(secret, absPath);
    } catch {
      return;
    }
    const secretStat = fsSync.statSync(secret, { bigint: true });

    const realRealpath = fsSync.realpathSync.native.bind(fsSync.realpathSync);
    const spy = vi.spyOn(fsSync.realpathSync, 'native').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      // Linux binds via /proc/self/fd and never realpath(absPath). Retarget
      // the in-root name on the first lookup of any candidate so the decoy
      // inode is distinct from the opened secret.
      try {
        if (fsSync.lstatSync(absPath).isSymbolicLink()) {
          fsSync.unlinkSync(absPath);
          fsSync.writeFileSync(absPath, 'trusted decoy');
        }
      } catch {
        /* absPath already replaced or gone */
      }
      return realRealpath(
        file as Parameters<typeof realRealpath>[0],
        options as Parameters<typeof realRealpath>[1],
      );
    }) as typeof fsSync.realpathSync.native);

    try {
      const primary = await outbound.sendFile('ou_owner', absPath, 'report.txt');
      expect(primary.ok).toBe(true);
      const decoyReal = realRealpath(absPath);
      const decoyStat = fsSync.statSync(decoyReal, { bigint: true });
      expect(primary.uploadedSource).toMatchObject({
        dev: String(secretStat.dev),
        ino: String(secretStat.ino),
      });
      expect(primary.uploadedSource!.ino).not.toBe(String(decoyStat.ino));
      expect(primary.uploadedSource!.realPath).not.toBe(decoyReal);
      if (primary.uploadedSource!.realPath) {
        const named = fsSync.statSync(primary.uploadedSource!.realPath, { bigint: true });
        expect(String(named.ino)).toBe(primary.uploadedSource!.ino);
        expect(String(named.dev)).toBe(primary.uploadedSource!.dev);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
