import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionRegistry } from '../session-registry.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionRegistry persistence', () => {
  it('starts empty and warns when the registry file is truncated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-registry-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '[{"sessionId":"unfinished"');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const registry = new SessionRegistry(file);

    expect(registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('session registry');
  });

  it('repairs a stale running flag left by a crash and rewrites the file (ROADMAP 1.10)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-registry-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'sessions.json');
    // What a hard daemon kill leaves behind: the turn's child died with the
    // daemon, but the record still claims a live turn.
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          sessionId: 'crashed-mid-turn',
          hermesSessionId: 'h-1',
          cwd: dir,
          lastSeq: 4,
          startedAt: new Date().toISOString(),
          lastEventAt: new Date().toISOString(),
          running: true,
        },
        {
          sessionId: 'idle',
          cwd: dir,
          lastSeq: 0,
          startedAt: new Date().toISOString(),
          lastEventAt: null,
          running: false,
        },
      ]),
    );

    const registry = new SessionRegistry(file);

    // The aborted turn is marked not-running; the resumable id survives.
    expect(registry.get('crashed-mid-turn')).toMatchObject({ running: false, hermesSessionId: 'h-1' });
    expect(registry.get('idle')).toMatchObject({ running: false });
    // The repair is persisted, not just in-memory: a second load sees it too.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ sessionId: string; running: boolean }>;
    expect(onDisk.find((r) => r.sessionId === 'crashed-mid-turn')?.running).toBe(false);
    expect(new SessionRegistry(file).get('crashed-mid-turn')?.running).toBe(false);
  });

  it('does not rewrite the file when no record claims a stale turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-registry-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'sessions.json');
    const payload = JSON.stringify([
      {
        sessionId: 'idle',
        cwd: dir,
        lastSeq: 0,
        startedAt: new Date().toISOString(),
        lastEventAt: null,
        running: false,
      },
    ]);
    fs.writeFileSync(file, payload);
    const before = fs.statSync(file).mtimeMs;

    new SessionRegistry(file);

    // No stale flag → no write (mtime untouched; content byte-identical).
    expect(fs.readFileSync(file, 'utf8')).toBe(payload);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});
