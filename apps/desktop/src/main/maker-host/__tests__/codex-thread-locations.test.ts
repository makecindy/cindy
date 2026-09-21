import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexThreadLocations } from '../codex-thread-locations';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-codex-account-history-'));
  directories.push(root);
  return { root, locations: new CodexThreadLocations(path.join(root, 'owner', 'locations')) };
}
describe('native thread locations across accounts', () => {
  it('keeps the original database home and recovers legacy location records', async () => {
    const { root, locations } = await fixture();
    const home = path.join(root, 'account-a');
    const rollout = path.join(home, 'sessions', '2026', '09', '09', 'rollout.jsonl');
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, 'history');
    await locations.record('thread-a', rollout);
    expect(await locations.readStorage('thread-a')).toEqual({ historyHome: home, sqliteHome: home, rolloutPath: rollout });
    await locations.record('thread-a', rollout, home);
    const reopened = new CodexThreadLocations(path.join(root, 'owner', 'locations'));
    expect(await reopened.readStorage('thread-a')).toEqual({ historyHome: home, sqliteHome: home, rolloutPath: rollout });
    expect(await reopened.readStorage('unknown')).toBeUndefined();
    expect(await fs.readFile(rollout, 'utf8')).toBe('history');
  });
  it('resolves unindexed legacy history before account host startup and remembers its native home', async () => {
    const { root, locations } = await fixture();
    const home = path.join(root, 'codex-home');
    const rollout = path.join(home, 'sessions', 'old.jsonl');
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, 'old native history\n');
    const prepare = vi.fn().mockResolvedValue(rollout);
    expect(await locations.readStorage('old-thread', { home, prepare })).toEqual({ historyHome: home, sqliteHome: home, rolloutPath: rollout });
    expect(prepare).toHaveBeenCalledWith('old-thread');
    expect(await locations.read('old-thread')).toBe(rollout);
    expect(await locations.readStorage('old-thread', { home, prepare })).toEqual({ historyHome: home, sqliteHome: home, rolloutPath: rollout });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(rollout, 'utf8')).toBe('old native history\n');
    await fs.rm(rollout);
    expect(await locations.readStorage('old-thread', { home, prepare })).toEqual({ historyHome: home, sqliteHome: home, rolloutPath: rollout });
    await expect(locations.read('old-thread')).rejects.toThrow();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('keeps an unmaterialized thread in its original homes across repeated model switches', async () => {
    const { root, locations } = await fixture();
    const historyHome = path.join(root, 'original-history');
    const sqliteHome = path.join(root, 'original-state');
    const rollout = path.join(historyHome, 'sessions', 'future.jsonl');
    await locations.record('unused-thread', rollout, sqliteHome);
    const prepare = vi.fn(async () => path.join(root, 'older-copy.jsonl'));
    const before = await fs.readFile(path.join(root, 'owner', 'locations', 'unused-thread.json'), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = new CodexThreadLocations(path.join(root, 'owner', 'locations'));
      expect(await reopened.readStorage('unused-thread', { home: root, prepare })).toEqual({
        historyHome, sqliteHome, rolloutPath: rollout,
      });
      expect(await reopened.prepareResume('unused-thread', prepare)).toBeUndefined();
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'owner', 'locations', 'unused-thread.json'), 'utf8')).toBe(before);
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, 'native history');
    expect(await locations.prepareResume('unused-thread', prepare)).toBe(rollout);
    expect(await fs.readFile(rollout, 'utf8')).toBe('native history');
  });

  it('does not treat invalid or unreadable history as an unused thread', async () => {
    const { root, locations } = await fixture();
    const rollout = path.join(root, 'sessions', 'rollout.jsonl');
    const prepare = vi.fn(async () => undefined);
    await locations.record('thread', rollout);
    await fs.mkdir(rollout, { recursive: true });
    await expect(locations.prepareResume('thread', prepare)).rejects.toThrow('history is unavailable');
    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const stat = vi.spyOn(fs, 'lstat').mockRejectedValueOnce(denied);
    try {
      await expect(locations.prepareResume('thread', prepare)).rejects.toBe(denied);
    } finally { stat.mockRestore(); }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not invent a storage home when legacy preparation finds no history', async () => {
    const { root, locations } = await fixture();
    const prepare = vi.fn().mockResolvedValue(undefined);
    expect(await locations.readStorage('missing', { home: root, prepare })).toBeUndefined();
    expect(await locations.read('missing')).toBeUndefined();
  });

  it('preserves the latest history when A resumes in B and returns to A', async () => {
    const { root, locations } = await fixture();
    const rollout = path.join(root, 'account-a.jsonl');
    await fs.writeFile(rollout, 'turn A\n');
    await locations.record('thread-1', rollout);
    const accountBPath = await locations.read('thread-1');
    await fs.appendFile(accountBPath!, 'turn B\n');
    const reopened = new CodexThreadLocations(path.join(root, 'owner', 'locations'));
    expect(await fs.readFile((await reopened.read('thread-1'))!, 'utf8')).toBe('turn A\nturn B\n');
  });
  it('distinguishes archived rollout ownership from an independently configured database home', async () => {
    const { root, locations } = await fixture();
    const historyHome = path.join(root, 'history-a');
    const sqliteHome = path.join(root, 'database-a');
    const rollout = path.join(historyHome, 'archived_sessions', 'rollout.jsonl');
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'archived' } }));
    await locations.record('archived', rollout, sqliteHome);
    expect(await locations.readStorage('archived')).toEqual({ historyHome, sqliteHome, rolloutPath: rollout });
  });
  it('never falls back to an older rollout after the canonical path disappears', async () => {
    const { root, locations } = await fixture();
    const rollout = path.join(root, 'latest.jsonl');
    await fs.writeFile(rollout, 'latest');
    await locations.record('thread-2', rollout);
    await fs.rm(rollout);
    await expect(locations.read('thread-2')).rejects.toThrow();
    await expect(locations.read('../escape')).rejects.toThrow('Invalid Codex thread id');
    expect(
      await new CodexThreadLocations(path.join(root, 'other-owner')).read('thread-2'),
    ).toBeUndefined();
  });
});
