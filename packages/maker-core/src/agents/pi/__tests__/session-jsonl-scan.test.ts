import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanPiSessionJsonl } from '../session-jsonl-scan.js';

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
});
