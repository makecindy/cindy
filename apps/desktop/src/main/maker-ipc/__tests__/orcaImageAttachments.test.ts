/**
 * orcaImageAttachments.test.ts — Orca images 入参地址解析回归。
 * 锁两类来源: 会话受管地址(cindy-media:// / xdt-image://)与任意本机绝对路径;
 * 非图片与不可解析一律 null。
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const userDataDir = path.join(os.tmpdir(), `orca-img-att-${randomUUID()}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { resolveOrcaImageAttachmentInput } = await import('../orcaImageAttachments');

const cacheRoot = path.join(userDataDir, 'cc-agent', 'images');
const sessionId = 'sess-orca-img';
const cachedFilename = 'aaaa1111-bbbb-2222-cccc-3333dddd4444-1700000000002.png';
const blobHash = 'e'.repeat(64);
const blobPath = path.join(userDataDir, 'cindy-media', 'blobs', 'ee', `${blobHash}.png`);
const videoBlobHash = 'f'.repeat(64);
const videoBlobPath = path.join(userDataDir, 'cindy-media', 'blobs', 'ff', `${videoBlobHash}.mp4`);
const plainDir = path.join(os.tmpdir(), `orca-img-plain-${randomUUID()}`);
const plainPath = path.join(plainDir, 'screenshot.png');
const textPath = path.join(plainDir, 'notes.txt');

beforeAll(async () => {
  await fsp.mkdir(path.join(cacheRoot, sessionId), { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, sessionId, cachedFilename), 'png-bytes');
  await fsp.mkdir(path.dirname(blobPath), { recursive: true });
  await fsp.writeFile(blobPath, 'png-bytes');
  await fsp.mkdir(path.dirname(videoBlobPath), { recursive: true });
  await fsp.writeFile(videoBlobPath, 'mp4-bytes');
  await fsp.mkdir(plainDir, { recursive: true });
  await fsp.writeFile(plainPath, 'png-bytes');
  await fsp.writeFile(textPath, 'text');
});

describe('resolveOrcaImageAttachmentInput', () => {
  it('resolves session image URIs and media store blob URIs', () => {
    expect(resolveOrcaImageAttachmentInput(`xdt-image://${sessionId}/${cachedFilename}`)).toEqual({
      absPath: path.join(cacheRoot, sessionId, cachedFilename),
      mimeType: 'image/png',
    });
    expect(resolveOrcaImageAttachmentInput(`cindy-media://blobs/${blobHash}.png`)).toEqual({
      absPath: blobPath,
      mimeType: 'image/png',
    });
  });

  it('falls back to any existing local image path', () => {
    expect(resolveOrcaImageAttachmentInput(plainPath)).toEqual({
      absPath: plainPath,
      mimeType: 'image/png',
    });
  });

  it('rejects non-image, missing, relative and non-blob URIs', () => {
    expect(resolveOrcaImageAttachmentInput(textPath)).toBeNull();
    expect(resolveOrcaImageAttachmentInput(path.join(plainDir, 'missing.png'))).toBeNull();
    expect(resolveOrcaImageAttachmentInput('relative/a.png')).toBeNull();
    expect(resolveOrcaImageAttachmentInput(`cindy-media://blobs/${videoBlobHash}.mp4`)).toBeNull();
    expect(resolveOrcaImageAttachmentInput(`cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`)).toBeNull();
  });
});
