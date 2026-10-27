import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relocateLibraryMetaOwner } from '../libraryBinding.js';
import { LibraryStagingStore, relocateLibraryStagingOwner } from '../libraryStaging.js';
import {
  finishLegacyLibraryReattach,
  LibrarySwapNeedsRestartError,
  readLegacyLibraryReattachJournal,
  relocateOrAdoptLibraryMeta,
  startLegacyLibraryReattach,
  withPluginHeldForLibrarySwap,
  type LegacyLibraryReattachDeps,
  type PluginHoldForLibrarySwapDeps,
} from '../libraryLegacyReattach.js';

const FROM = 'xd-mivo-canvas';
const TO = '_ns__xd__xd-mivo-canvas';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-library-reattach-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plantLibrary(dir: string, ghostId: string, marker: string): void {
  fs.mkdirSync(path.join(dir, '.cindy-library'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.cindy-library', 'meta.json'),
    JSON.stringify({ version: 1, ghostId, createdAt: 1, orphaned: { at: 1, name: 'Mivo Canvas' } }),
  );
  fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
}

function readMeta(dir: string): { ghostId: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, '.cindy-library', 'meta.json'), 'utf8')) as { ghostId: string };
}

function deps(overrides: Partial<LegacyLibraryReattachDeps> = {}): LegacyLibraryReattachDeps {
  return {
    journalFile: () => path.join(root, 'library-reattach.json'),
    defaultRoot: (id) => path.join(root, 'libraries', id),
    stagingRoot: (id) => path.join(root, 'library-staging', id),
    trashRoot: () => path.join(root, 'libraries-trash'),
    relocateCustomBinding: async () => {},
    assertCustomBindingRelocatable: async () => {},
    customRoot: async () => null,
    relocateMeta: async (dir, fromId, toId) => {
      await relocateLibraryMetaOwner(dir, fromId, toId);
    },
    relocateStaging: async (dir, fromId, toId) => {
      await relocateLibraryMetaOwner(dir, fromId, toId);
    },
    assertCurrent: () => {},
    ...overrides,
  };
}

function plantDefaultPair(): void {
  plantLibrary(path.join(root, 'libraries', FROM), FROM, 'old');
  plantLibrary(path.join(root, 'libraries', TO), TO, 'new');
  plantLibrary(path.join(root, 'library-staging', FROM), FROM, 'old-staging');
  plantLibrary(path.join(root, 'library-staging', TO), TO, 'new-staging');
}

function expectReattached(): void {
  const library = path.join(root, 'libraries', TO);
  expect(fs.readFileSync(path.join(library, 'marker.txt'), 'utf8')).toBe('old');
  expect(readMeta(library).ghostId).toBe(TO);
  expect(fs.existsSync(path.join(root, 'libraries', FROM))).toBe(false);
  const staging = path.join(root, 'library-staging', TO);
  expect(fs.readFileSync(path.join(staging, 'marker.txt'), 'utf8')).toBe('old-staging');
  expect(readMeta(staging).ghostId).toBe(TO);
  const trash = path.join(root, 'libraries-trash', `${TO}-7-replaced`);
  expect(fs.readFileSync(path.join(trash, 'marker.txt'), 'utf8')).toBe('new');
  expect(fs.readFileSync(path.join(`${trash}-staging`, 'marker.txt'), 'utf8')).toBe('new-staging');
  expect(fs.existsSync(path.join(root, 'library-reattach.json'))).toBe(false);
}

describe('legacy library reattach', () => {
  it('moves the current library to the trash and puts the old one in its place', async () => {
    plantDefaultPair();
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps());
    expectReattached();
  });

  it('reattaches when the current instance never created a library', async () => {
    plantLibrary(path.join(root, 'libraries', FROM), FROM, 'old');
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps());
    expect(readMeta(path.join(root, 'libraries', TO)).ghostId).toBe(TO);
    expect(fs.existsSync(path.join(root, 'libraries-trash'))).toBe(false);
  });

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))(
    'finishes from the journal after stopping at check %i',
    async (stopAt) => {
      plantDefaultPair();
      let checks = 0;
      const interrupted = deps({
        assertCurrent: () => {
          checks += 1;
          if (checks === stopAt) throw new Error('stopped');
        },
      });
      await expect(startLegacyLibraryReattach(
        { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
        interrupted,
      )).rejects.toThrow('stopped');
      const journal = await readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'));
      if (journal) await finishLegacyLibraryReattach(journal, deps());
      if (stopAt <= 3) {
        // Stopped before the journal was written: nothing moved.
        expect(journal).toBeNull();
        expect(fs.readFileSync(path.join(root, 'libraries', TO, 'marker.txt'), 'utf8')).toBe('new');
        return;
      }
      expectReattached();
    },
  );

  it('does not trash a different library that took the current place', async () => {
    plantDefaultPair();
    await expect(startLegacyLibraryReattach(
      { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
      deps({ assertCurrent: (() => {
        let checks = 0;
        return () => {
          checks += 1;
          if (checks === 4) throw new Error('stopped');
        };
      })() }),
    )).rejects.toThrow('stopped');
    const current = path.join(root, 'libraries', TO);
    // Keep the original inode alive so the replacement cannot reuse it.
    fs.renameSync(current, path.join(root, 'moved-away'));
    plantLibrary(current, TO, 'replacement');
    const journal = await readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'));
    await expect(finishLegacyLibraryReattach(journal!, deps())).rejects.toThrow('destination already exists');
    expect(fs.readFileSync(path.join(current, 'marker.txt'), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(root, 'libraries', FROM, 'marker.txt'), 'utf8')).toBe('old');
  });

  it('refuses to start another reattach while one is unfinished', async () => {
    fs.writeFileSync(path.join(root, 'library-reattach.json'), JSON.stringify({
      version: 1, fromId: FROM, toId: TO, oldLocation: 'default', newLibrary: null, newStaging: null, trashName: 'x',
    }));
    await expect(startLegacyLibraryReattach(
      { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
      deps(),
    )).rejects.toThrow('unfinished');
  });

  it('lets the binding store move a library at a custom location', async () => {
    const custom = path.join(root, 'custom');
    plantLibrary(path.join(custom, FROM), FROM, 'old');
    const relocateCustomBinding = vi.fn(async (fromId: string, toId: string) => {
      fs.renameSync(path.join(custom, fromId), path.join(custom, toId));
    });
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'custom', now: 7 }, deps({
      relocateCustomBinding,
      customRoot: async (id) => path.join(custom, id),
    }));
    expect(relocateCustomBinding).toHaveBeenCalledWith(FROM, TO);
    expect(readMeta(path.join(custom, TO)).ghostId).toBe(TO);
  });

  it('flushes every moved directory and identity before removing the journal', async () => {
    plantDefaultPair();
    const order: string[] = [];
    const journal = path.join(root, 'library-reattach.json');
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps({
      syncDirectory: async (dir) => {
        order.push((fs.existsSync(journal) ? 'before:' : 'after:') + path.relative(root, dir));
      },
    }));
    expect(order).toEqual([
      'before:libraries-trash',
      'before:libraries',
      'before:library-staging',
      `before:${path.join('libraries', TO, '.cindy-library')}`,
      `before:${path.join('library-staging', TO, '.cindy-library')}`,
      'after:',
    ]);
    expectReattached();
  });

  it('keeps the journal when the account switches while the moves are flushed', async () => {
    plantDefaultPair();
    const ownJournal = path.join(root, 'library-reattach.json');
    const otherJournal = path.join(root, 'other-account', 'library-reattach.json');
    fs.mkdirSync(path.dirname(otherJournal), { recursive: true });
    fs.writeFileSync(otherJournal, 'other account');
    let switched = false;
    await expect(startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps({
      journalFile: () => (switched ? otherJournal : ownJournal),
      assertCurrent: () => {
        if (switched) throw new Error('owner changed');
      },
      syncDirectory: async () => {
        switched = true;
      },
    }))).rejects.toThrow('owner changed');
    expect(fs.existsSync(ownJournal)).toBe(true);
    expect(fs.readFileSync(otherJournal, 'utf8')).toBe('other account');
  });

  it('stops before moving anything when the custom destination is already taken', async () => {
    plantDefaultPair();
    const custom = path.join(root, 'custom');
    plantLibrary(path.join(custom, FROM), FROM, 'old');
    fs.mkdirSync(path.join(custom, TO));
    const relocateCustomBinding = vi.fn(async () => {});
    await expect(startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'custom', now: 7 }, deps({
      relocateCustomBinding,
      assertCustomBindingRelocatable: async (_fromId, toId) => {
        if (fs.existsSync(path.join(custom, toId))) throw new Error('library custom root destination already exists');
      },
      customRoot: async (id) => path.join(custom, id),
    }))).rejects.toThrow('destination already exists');
    expect(relocateCustomBinding).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'library-reattach.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'libraries', TO, 'marker.txt'), 'utf8')).toBe('new');
  });

  it('stops before moving anything when the old custom library is unavailable', async () => {
    plantDefaultPair();
    const relocateCustomBinding = vi.fn(async () => {});
    await expect(startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'custom', now: 7 }, deps({
      relocateCustomBinding,
      customRoot: async (id) => path.join(root, 'unmounted', id),
    }))).rejects.toThrow();
    expect(relocateCustomBinding).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'library-reattach.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'libraries', TO, 'marker.txt'), 'utf8')).toBe('new');
  });

  it('treats an existing trash target as done, even if directory identity cannot tell the libraries apart', async () => {
    plantDefaultPair();
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps());
    // A volume without inode numbers reports the same identity for every
    // directory; make the recorded identity match the reattached library.
    const stat = fs.lstatSync(path.join(root, 'libraries', TO));
    const stagingStat = fs.lstatSync(path.join(root, 'library-staging', TO));
    await finishLegacyLibraryReattach({
      version: 1, fromId: FROM, toId: TO, oldLocation: 'default',
      newLibrary: { dev: stat.dev, ino: stat.ino },
      newStaging: { dev: stagingStat.dev, ino: stagingStat.ino },
      trashName: `${TO}-7-replaced`,
    }, deps());
    expectReattached();
  });

  it.each([
    ['a path in fromId', { fromId: '../outside' }],
    ['a path in toId', { toId: '../../outside' }],
    ['a parent trash name', { trashName: '..' }],
  ])('rejects a journal with %s', async (_label, change) => {
    fs.writeFileSync(path.join(root, 'library-reattach.json'), JSON.stringify({
      version: 1, fromId: FROM, toId: TO, oldLocation: 'default', newLibrary: null, newStaging: null, trashName: 'x',
      ...change,
    }));
    await expect(readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'))).rejects.toThrow('invalid');
  });
});

describe('staging tasks during a reattach', () => {
  const OWNER_SCOPE = 'local:owner-a:1';

  function stagingStore(dir: string, ghostId: string): LibraryStagingStore {
    return new LibraryStagingStore({
      rootDir: dir, ghostId, ownerScopeKey: OWNER_SCOPE,
      captureOwnerScope: () => OWNER_SCOPE, getDiskFreeBytes: async () => 1024 ** 4,
    });
  }

  async function beginUpload(store: LibraryStagingStore, taskId: string, body: string): Promise<string> {
    const bytes = Buffer.from(body);
    const begin = await store.begin({
      ghostId: FROM, taskId, sourceRevision: 'rev-1', totalBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png',
      recovery: { sceneId: 's1', nodeId: 'n1' },
    });
    if (!begin.ok) throw new Error(JSON.stringify(begin));
    const chunk = await store.chunk({
      ghostId: FROM, stagingId: begin.stagingId, seq: 1, content: bytes.toString('base64'), encoding: 'base64',
    });
    if (!chunk.ok) throw new Error(JSON.stringify(chunk));
    return begin.stagingId;
  }

  function taskOwners(dir: string): string[] {
    const tasks = path.join(dir, 'tasks');
    return fs.readdirSync(tasks).flatMap((id) => ['manifest.json', 'intent.json']
      .map((name) => path.join(tasks, id, name))
      .filter((file) => fs.existsSync(file))
      .map((file) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { ghostId: string }).ghostId));
  }

  it('finishes rewriting upload tasks after stopping with only some of them moved', async () => {
    plantLibrary(path.join(root, 'libraries', FROM), FROM, 'old');
    const oldStaging = path.join(root, 'library-staging', FROM);
    const store = stagingStore(oldStaging, FROM);
    const durable = await beginUpload(store, 'durable', 'pixel-bytes');
    expect((await store.commit({ ghostId: FROM, stagingId: durable })).ok).toBe(true);
    await beginUpload(store, 'unfinished-1', 'pending-1');
    await beginUpload(store, 'unfinished-2', 'pending-2');
    await store.dispose();

    const newStaging = path.join(root, 'library-staging', TO);
    let stopped = false;
    const relocateStaging = async (dir: string, fromId: string, toId: string): Promise<void> => {
      await relocateLibraryStagingOwner(dir, fromId, toId, OWNER_SCOPE, () => {
        const owners = taskOwners(newStaging);
        if (!stopped && owners.includes(TO) && owners.includes(FROM)) {
          stopped = true;
          throw new Error('stopped');
        }
      });
    };
    await expect(startLegacyLibraryReattach(
      { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
      deps({ relocateStaging }),
    )).rejects.toThrow('stopped');
    expect(new Set(taskOwners(newStaging))).toEqual(new Set([FROM, TO]));

    const journal = await readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'));
    await finishLegacyLibraryReattach(journal!, deps({ relocateStaging }));
    expect(new Set(taskOwners(newStaging))).toEqual(new Set([TO]));
    const restored = stagingStore(newStaging, TO);
    expect(await restored.list({ ghostId: TO })).toMatchObject({
      ok: true, items: [expect.objectContaining({ stagingId: durable })],
    });
    expect(await restored.read({ ghostId: TO, stagingId: durable })).toMatchObject({
      ok: true, content: Buffer.from('pixel-bytes').toString('base64'),
    });
    await restored.dispose();
  });
});

describe('library without host identity', () => {
  it('gets the new owner written in, and a rerun keeps it', async () => {
    const library = path.join(root, 'libraries', FROM);
    fs.mkdirSync(path.join(library, 'store'), { recursive: true });
    fs.writeFileSync(path.join(library, 'store', 'canvas.json'), '{}');
    const relocate = vi.fn(async (dir: string, fromId: string, toId: string) => {
      await relocateLibraryMetaOwner(dir, fromId, toId);
    });
    await relocateOrAdoptLibraryMeta(library, FROM, TO, relocate, 9);
    expect(readMeta(library)).toMatchObject({ ghostId: TO, createdAt: 9 });
    expect(relocate).not.toHaveBeenCalled();
    await relocateOrAdoptLibraryMeta(library, FROM, TO, relocate, 10);
    expect(relocate).toHaveBeenCalledTimes(1);
    expect(readMeta(library)).toMatchObject({ ghostId: TO, createdAt: 9 });
  });

  it('writes the identity on a rerun that stopped after the identity folder was made', async () => {
    const library = path.join(root, 'libraries', FROM);
    fs.mkdirSync(path.join(library, '.cindy-library'), { recursive: true });
    fs.writeFileSync(path.join(library, '.cindy-library', 'meta.json.leftover.tmp'), '{');
    const relocate = vi.fn(async () => {});
    await relocateOrAdoptLibraryMeta(library, FROM, TO, relocate, 9);
    expect(relocate).not.toHaveBeenCalled();
    expect(readMeta(library)).toMatchObject({ ghostId: TO, createdAt: 9 });
  });

  it('relocates an existing identity instead of overwriting it', async () => {
    const library = path.join(root, 'libraries', FROM);
    plantLibrary(library, FROM, 'old');
    const relocate = vi.fn(async (dir: string, fromId: string, toId: string) => {
      await relocateLibraryMetaOwner(dir, fromId, toId);
    });
    await relocateOrAdoptLibraryMeta(library, FROM, TO, relocate);
    expect(relocate).toHaveBeenCalledWith(library, FROM, TO);
    expect(readMeta(library)).toMatchObject({ ghostId: TO, createdAt: 1 });
  });
});

describe('plugin hold during a library swap', () => {
  function recorder(overrides: Partial<PluginHoldForLibrarySwapDeps> = {}) {
    const calls: string[] = [];
    const deps: PluginHoldForLibrarySwapDeps = {
      stopRuntime: async () => { calls.push('stop'); return { browser: true, node: false }; },
      notifyPanels: (phase) => { calls.push('panels:' + phase); },
      closePages: async () => { calls.push('close-pages'); },
      holdLibraries: (on) => { calls.push(on ? 'hold' : 'release'); },
      disposeLibraries: async () => { calls.push('dispose'); },
      clearPartitionStorage: async () => { calls.push('clear'); },
      restartRuntime: (running) => { calls.push('restart:' + running.browser + ':' + running.node); },
      warn: () => { calls.push('warn'); },
      ...overrides,
    };
    return { calls, deps };
  }

  it('closes old pages before the swap and again before clearing, then restores the plugin', async () => {
    const { calls, deps } = recorder();
    await withPluginHeldForLibrarySwap(deps, async () => { calls.push('swap'); });
    expect(calls).toEqual([
      'stop', 'panels:start', 'hold', 'close-pages', 'dispose', 'swap',
      'close-pages', 'clear', 'release', 'restart:true:false', 'panels:done',
    ]);
  });

  it('still clears and restores when the swap stops midway', async () => {
    const { calls, deps } = recorder();
    await expect(withPluginHeldForLibrarySwap(deps, async () => { throw new Error('stopped'); }))
      .rejects.toThrow('stopped');
    expect(calls.slice(-5)).toEqual(['close-pages', 'clear', 'release', 'restart:true:false', 'panels:done']);
  });

  it('retries a failed clear once and then restores the plugin', async () => {
    let attempts = 0;
    const { calls, deps } = recorder({
      clearPartitionStorage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('busy');
        calls.push('clear');
      },
    });
    await withPluginHeldForLibrarySwap(deps, async () => {});
    expect(calls.slice(-6)).toEqual(['warn', 'close-pages', 'clear', 'release', 'restart:true:false', 'panels:done']);
  });

  it.each([
    ['the swap finished', async () => {}],
    ['the swap stopped midway', async () => { throw new Error('stopped'); }],
  ])('keeps the plugin stopped and the library held when the clear keeps failing after %s', async (_label, swap) => {
    const { calls, deps } = recorder({ clearPartitionStorage: async () => { throw new Error('busy'); } });
    await expect(withPluginHeldForLibrarySwap(deps, swap)).rejects.toBeInstanceOf(LibrarySwapNeedsRestartError);
    expect(calls).not.toContain('release');
    expect(calls.some((call) => call.startsWith('restart'))).toBe(false);
    expect(calls).not.toContain('panels:done');
  });
});
