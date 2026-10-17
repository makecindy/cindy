import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodexModelListItem, RemoteCodexImageAttachment } from '@cindy/maker-core';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertRemoteCodexModelSupportsImages,
  cleanupRemoteCodexSessionImages,
  stageRemoteCodexImageFiles,
} from '../remote-codex-attachments.js';

const tempDirs: string[] = [];

async function tempImage(bytes = Buffer.from('image-bytes')): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-codex-image-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'shot.png');
  await fs.writeFile(file, bytes);
  return file;
}

function model(patch: Partial<CodexModelListItem> = {}): CodexModelListItem {
  return {
    id: 'vision-model',
    model: 'vision-model',
    displayName: 'Vision',
    description: '',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: [],
    serviceTiers: [],
    inputModalities: ['text', 'image'],
    isDefault: true,
    ...patch,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('remote Codex image admission', () => {
  it('requires an explicit image input modality', () => {
    expect(() => assertRemoteCodexModelSupportsImages([model()], 'vision-model')).not.toThrow();
    expect(() => assertRemoteCodexModelSupportsImages(
      [model({ inputModalities: ['text'] })],
      'vision-model',
    )).toThrow('does not support image input');
    expect(() => assertRemoteCodexModelSupportsImages(
      [model({ inputModalities: undefined })],
      'vision-model',
    )).toThrow('cannot verify image input support');
    expect(() => assertRemoteCodexModelSupportsImages([model()], 'missing'))
      .toThrow('is unavailable');
  });
});

describe('remote Codex image staging', () => {
  it('uploads bytes over stdin, verifies the exact digest/path and returns an absolute path', async () => {
    const bytes = Buffer.from('png-ish payload');
    const imagePath = await tempImage(bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const remotePath = `/home/tester/.xdt-server/v1/session-attachments/session-1/${digest}.png`;
    const exec = vi.fn(async (cmd: string, opts?: { input?: string | Buffer; label?: string }) => {
      if (opts?.label === 'remote-codex-attachment-home') {
        return { stdout: '/home/tester\n', stderr: '', exitCode: 0, signal: null, truncated: false };
      }
      expect(opts?.label).toBe('remote-codex-image-write');
      expect(cmd).toContain(digest);
      expect(cmd).toContain(`'${bytes.length}'`);
      expect(cmd).not.toContain(bytes.toString('utf8'));
      expect(Buffer.isBuffer(opts?.input)).toBe(true);
      expect((opts?.input as Buffer).equals(bytes)).toBe(true);
      return { stdout: `${remotePath}\n`, stderr: '', exitCode: 0, signal: null, truncated: false };
    });
    const remoteHost = { id: 'stage-host', exec } as unknown as RemoteHost;
    const images: RemoteCodexImageAttachment[] = [{ path: imagePath, mimeType: 'image/png' }];

    await expect(stageRemoteCodexImageFiles({
      remoteHost,
      sessionId: 'session-1',
      images,
    })).resolves.toEqual([remotePath]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('re-resolves HOME on every operation so SSH host edits cannot reuse a stale login home', async () => {
    const bytes = Buffer.from('same-image');
    const imagePath = await tempImage(bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    let homeCalls = 0;
    let writeCalls = 0;
    const exec = vi.fn(async (_cmd: string, opts?: { label?: string }) => {
      if (opts?.label === 'remote-codex-attachment-home') {
        homeCalls += 1;
        return {
          stdout: `${homeCalls === 1 ? '/home/first' : '/home/second'}\n`,
          stderr: '', exitCode: 0, signal: null, truncated: false,
        };
      }
      const home = writeCalls++ === 0 ? '/home/first' : '/home/second';
      return {
        stdout: `${home}/.xdt-server/v1/session-attachments/session-4/${digest}.png\n`,
        stderr: '', exitCode: 0, signal: null, truncated: false,
      };
    });
    const remoteHost = { id: 'edited-host', exec } as unknown as RemoteHost;

    await expect(stageRemoteCodexImageFiles({
      remoteHost,
      sessionId: 'session-4',
      images: [{ path: imagePath }],
    })).resolves.toEqual([`/home/first/.xdt-server/v1/session-attachments/session-4/${digest}.png`]);
    await expect(stageRemoteCodexImageFiles({
      remoteHost,
      sessionId: 'session-4',
      images: [{ path: imagePath }],
    })).resolves.toEqual([`/home/second/.xdt-server/v1/session-attachments/session-4/${digest}.png`]);
    expect(homeCalls).toBe(2);
  });

  it('fails closed when the host reports a verification failure', async () => {
    const imagePath = await tempImage();
    const exec = vi.fn(async (_cmd: string, opts?: { label?: string }) => {
      if (opts?.label === 'remote-codex-attachment-home') {
        return { stdout: '/home/tester\n', stderr: '', exitCode: 0, signal: null, truncated: false };
      }
      return { stdout: '', stderr: 'remote image sha256 verification failed', exitCode: 47, signal: null, truncated: false };
    });
    const remoteHost = { id: 'failed-stage-host', exec } as unknown as RemoteHost;

    await expect(stageRemoteCodexImageFiles({
      remoteHost,
      sessionId: 'session-2',
      images: [{ path: imagePath }],
    })).rejects.toThrow('image upload failed');
  });

  it('cleans the session-scoped remote directory', async () => {
    const exec = vi.fn(async (_cmd: string, opts?: { label?: string }) => {
      if (opts?.label === 'remote-codex-attachment-home') {
        return { stdout: '/home/tester\n', stderr: '', exitCode: 0, signal: null, truncated: false };
      }
      expect(opts?.label).toBe('remote-codex-image-cleanup');
      return { stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false };
    });
    const remoteHost = { id: 'cleanup-host', exec } as unknown as RemoteHost;

    await cleanupRemoteCodexSessionImages({ remoteHost, sessionId: 'session-3' });
    expect(exec.mock.calls[1]?.[0]).toContain('/home/tester/.xdt-server/v1/session-attachments/session-3');
  });
});
