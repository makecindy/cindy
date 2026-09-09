import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
import { recycleJournalRoot, watchRecycleJournal } from '../worktree/recycleJournal';

describe('native worktree journal watcher', () => {
  let stop: (() => void) | undefined;
  beforeEach(async () => { state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-recycle-watch-')); });
  afterEach(async () => { stop?.(); await fs.rm(state.root, { recursive: true, force: true }); });

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
});
