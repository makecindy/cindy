import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  pinLocalPiSessionDir,
  resolveLocalPiSessionScanFile,
  scanPiSessionJsonl,
} from '../session-jsonl-scan.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sessionFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-session-scan-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

describe('scanPiSessionJsonl', () => {
  it('collects user entry ids and the last plan-mode flag without loading image payloads', async () => {
    const hugeImage = `{"type":"message","id":"img1","parentId":"root","message":{"role":"user","content":[{"type":"image","data":"${'A'.repeat(8000)}"}]}}`;
    const file = await sessionFile([
      '{"type":"session","version":3,"id":"s1"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      hugeImage,
      '{"type":"custom","id":"p1","customType":"plan-mode","data":{"enabled":true}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      '{"type":"custom","id":"p2","customType":"plan-mode","data":{"enabled":false}}',
    ]);

    const scan = await scanPiSessionJsonl(file);
    expect(scan).not.toBeNull();
    expect([...scan!.userEntryIds].sort()).toEqual(['img1', 'u1']);
    expect(scan!.lastPlanModeEnabled).toBe(false);
  });

  it('returns null when the session file is missing', async () => {
    await expect(scanPiSessionJsonl(path.join(os.tmpdir(), 'missing-pi-session.jsonl'))).resolves.toBeNull();
  });

  it('returns null for a symlink or directory instead of following it', async () => {
    const file = await sessionFile([
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    ]);
    const link = path.join(path.dirname(file), 'session.link');
    await symlink(file, link);
    await expect(scanPiSessionJsonl(link)).resolves.toBeNull();
    await expect(scanPiSessionJsonl(path.dirname(file))).resolves.toBeNull();
  });

  it('reads plan-mode from the active leaf path, not a sibling branch', async () => {
    const file = await sessionFile([
      '{"type":"session","version":3,"id":"s1","leafId":"u2"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"custom","id":"p1","parentId":"u1","customType":"plan-mode","data":{"enabled":true}}',
      '{"type":"message","id":"u2","parentId":"u1","message":{"role":"user","content":[{"type":"text","text":"other branch"}]}}',
    ]);
    const scan = await scanPiSessionJsonl(file);
    expect(scan).not.toBeNull();
    expect([...scan!.userEntryIds].sort()).toEqual(['u1', 'u2']);
    expect(scan!.lastPlanModeEnabled).toBeNull();
  });

  it('returns null when the scan exceeds the byte budget', async () => {
    const file = await sessionFile([
      '{"type":"session","version":3,"id":"s1"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    ]);
    await expect(scanPiSessionJsonl(file, { maxBytes: 16 })).resolves.toBeNull();
  });
});

describe('resolveLocalPiSessionScanFile', () => {
  it('accepts a regular file inside the pinned session dir and rejects anything else', async () => {
    const sessionDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-session-dir-')));
    dirs.push(sessionDir);
    const pinned = await pinLocalPiSessionDir(sessionDir);
    expect(pinned).not.toBeNull();
    const inside = path.join(sessionDir, 'session.jsonl');
    await writeFile(inside, '{"type":"session","id":"s1"}\n');
    const realInside = await realpath(inside);
    await expect(resolveLocalPiSessionScanFile(pinned!, inside)).resolves.toBe(realInside);
    await expect(resolveLocalPiSessionScanFile(pinned!, 'session.jsonl')).resolves.toBe(realInside);

    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'pi-session-outside-'));
    dirs.push(outsideDir);
    const outside = path.join(outsideDir, 'session.jsonl');
    await writeFile(outside, '{"type":"session","id":"s1"}\n');
    await expect(resolveLocalPiSessionScanFile(pinned!, outside)).resolves.toBeNull();
    await expect(resolveLocalPiSessionScanFile(pinned!, sessionDir)).resolves.toBeNull();
  });

  it('rejects a session file whose directory was replaced with an outside symlink', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-session-swap-')));
    dirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const evilDir = path.join(root, 'evil');
    await mkdir(sessionDir);
    await mkdir(evilDir);
    const pinned = await pinLocalPiSessionDir(sessionDir);
    expect(pinned).not.toBeNull();
    const inside = path.join(sessionDir, 'session.jsonl');
    await writeFile(inside, '{"type":"session","id":"granted"}\n');
    await writeFile(path.join(evilDir, 'session.jsonl'), '{"type":"session","id":"evil"}\n');
    await expect(resolveLocalPiSessionScanFile(pinned!, inside)).resolves.not.toBeNull();

    await rm(sessionDir, { recursive: true, force: true });
    await symlink(evilDir, sessionDir, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveLocalPiSessionScanFile(pinned!, inside)).resolves.toBeNull();
  });

  it('rejects a session file whose directory was replaced by a new ordinary directory', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-session-replace-')));
    dirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir);
    const pinned = await pinLocalPiSessionDir(sessionDir);
    expect(pinned).not.toBeNull();
    const inside = path.join(sessionDir, 'session.jsonl');
    await writeFile(inside, '{"type":"session","id":"granted"}\n');
    await expect(resolveLocalPiSessionScanFile(pinned!, inside)).resolves.not.toBeNull();

    await rm(sessionDir, { recursive: true, force: true });
    await mkdir(sessionDir);
    await writeFile(inside, '{"type":"session","id":"evil"}\n');
    await expect(resolveLocalPiSessionScanFile(pinned!, inside)).resolves.toBeNull();
  });
});
