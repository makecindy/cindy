import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '', userData: '' }));
vi.mock('electron', () => ({ app: { getPath: (name: string) => name === 'appData' ? path.join(state.root, 'app-data') : (state.userData || state.root) } }));
import { newRecycleRecord, readRecycleRecordsAcrossProfiles, recycleJournalRoot, watchRecycleJournal, writeRecycleRecord } from '../worktree/recycleJournal';
import { withWorktreeResourceLock } from '../worktree/resourceLock';

describe('native worktree journal watcher', () => {
  let stop: (() => void) | undefined;
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-recycle-watch-'));
    state.userData = ''; stop = undefined;
  });
  afterEach(async () => { stop?.(); vi.restoreAllMocks(); await fs.rm(state.root, { recursive: true, force: true }); });

  const recordFor = () => newRecycleRecord({
    sessionId: 'owner', name: 'one', path: path.join(state.root, 'repo', '.cindy-worktrees', 'one'),
    baseRepo: path.join(state.root, 'repo'), branch: 'cindy/one', sourceBranch: 'main', createdAt: new Date().toISOString(),
  });

  it('detects atomic replacements from an independent file writer', async () => {
    const changed = vi.fn(); const error = vi.fn();
    stop = await watchRecycleJournal(changed, error);
    const target = path.join(recycleJournalRoot(), 'a'.repeat(64) + '.json');
    await fs.writeFile(target + '.tmp', '{}');
    await fs.rename(target + '.tmp', target);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    changed.mockClear();
    await fs.writeFile(target + '.tmp', '{"updated":true}');
    await fs.rename(target + '.tmp', target);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(error).not.toHaveBeenCalled();
  });

  it('publishes pre-upgrade requests on watcher startup and reads later owner progress directly', async () => {
    state.userData = path.join(state.root, 'custom-owner-profile');
    const ownerRoot = recycleJournalRoot();
    const record = await recordFor();
    record.phase = 'removing';
    await fs.mkdir(ownerRoot, { recursive: true });
    const file = path.join(ownerRoot, `${record.id}.json`);
    await fs.writeFile(file, JSON.stringify(record));
    stop = await watchRecycleJournal(vi.fn(), vi.fn());
    state.userData = path.join(state.root, 'borrower-profile');
    expect(await readRecycleRecordsAcrossProfiles(record.meta.path)).toEqual([record]);
    // The owner can finish using the original journal protocol without updating a mirror.
    record.phase = 'restored';
    await fs.writeFile(`${file}.tmp`, JSON.stringify(record));
    await fs.rename(`${file}.tmp`, file);
    expect(await readRecycleRecordsAcrossProfiles(record.meta.path)).toEqual([record]);
  });

  it('keeps different profiles current records independent for the same resource', async () => {
    const record = await recordFor();
    await withWorktreeResourceLock(record.meta.path, () => writeRecycleRecord(record));
    state.userData = path.join(state.root, 'second-owner');
    const other = { ...record, phase: 'restored' as const, generation: 'other-generation' };
    await withWorktreeResourceLock(record.meta.path, () => writeRecycleRecord(other));
    state.userData = path.join(state.root, 'borrower');
    expect(await readRecycleRecordsAcrossProfiles(record.meta.path)).toEqual(expect.arrayContaining([record, other]));
    expect(await readRecycleRecordsAcrossProfiles(record.meta.path)).toHaveLength(2);
  });

  it('preserves and rejects malformed owner evidence without reading unrelated resource records', async () => {
    const record = await recordFor();
    await withWorktreeResourceLock(record.meta.path, () => writeRecycleRecord(record));
    const file = path.join(recycleJournalRoot(), `${record.id}.json`);
    await fs.writeFile(file, '{');
    state.userData = path.join(state.root, 'borrower');
    await expect(readRecycleRecordsAcrossProfiles(record.meta.path)).rejects.toThrow();
    expect(await readRecycleRecordsAcrossProfiles(path.join(state.root, 'different-resource'))).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('{');
  });

  it('does not commit a recycle intent if publishing its location fails', async () => {
    const record = await recordFor();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).includes('shared-worktree-recycle-journals')) throw Object.assign(new Error('unavailable'), { code: 'EIO' });
      return rename(source, target);
    });
    await expect(withWorktreeResourceLock(record.meta.path, () => writeRecycleRecord(record))).rejects.toMatchObject({ code: 'EIO' });
    await expect(fs.stat(path.join(recycleJournalRoot(), `${record.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
