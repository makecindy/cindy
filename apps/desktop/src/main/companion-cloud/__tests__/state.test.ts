import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanionCloudState } from '../state.js';

describe('companion sync state file', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  it('starts empty from a corrupt file and persists updates atomically', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'companion-state-'));
    const filePath = path.join(dir, 'nested', 'state.json');
    const log = { warn: vi.fn() };
    writeFileSync(path.join(dir, 'corrupt.json'), '{not json');
    const corrupt = createCompanionCloudState({ filePath: path.join(dir, 'corrupt.json'), log });
    expect(corrupt.bot('a')).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();

    const state = createCompanionCloudState({ filePath });
    state.update('a', 'actor-a', entry => { entry.roomId = 'room'; entry.prefs.k = { hash: 'h', revision: 2 }; });
    const reread = createCompanionCloudState({ filePath });
    expect(reread.bot('a')).toEqual({ actorId: 'actor-a', roomId: 'room', prefs: { k: { hash: 'h', revision: 2 } } });
    expect(reread.botForRoom('room')).toBe('a');
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
    // A different cloud actor for the same local id starts from scratch.
    reread.update('a', 'actor-b', () => undefined);
    expect(reread.bot('a')).toEqual({ actorId: 'actor-b', prefs: {} });
  });

  it('applies an update in this run when the disk write fails, and saves it with the next one', () => {
    const writes: string[] = [];
    let failing = true;
    const state = createCompanionCloudState({ filePath: 'state.json', io: { read: () => null, write: (_path, contents) => {
      if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      writes.push(contents);
    } } });
    state.update('a', 'actor', entry => { entry.demoted = true; });
    expect(state.isDemoted('a')).toBe(true);
    failing = false;
    state.update('b', 'actor-b', () => undefined);
    expect(JSON.parse(writes.at(-1)!).bots.a.demoted).toBe(true);
  });

  it('refuses writes after the account changed', () => {
    const state = createCompanionCloudState({ filePath: 'unused.json', current: () => false,
      io: { read: () => null, write: () => { throw new Error('must not write'); } } });
    expect(() => state.update('a', 'actor', () => undefined)).toThrow('OWNER_CHANGED');
  });
});
