import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareDirectoryGrantsForBootstrap } from '../makerSendTransaction';
import type { MakerSessionCreateOpts } from '../sessionRequest';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeGrantTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-bootstrap-grants-'));
  cleanupDirs.push(root);
  const workspace = path.join(root, 'workspace');
  const shared = path.join(root, 'shared');
  const specs = path.join(shared, 'specs');
  const output = path.join(root, 'output');
  mkdirSync(workspace);
  mkdirSync(specs, { recursive: true });
  mkdirSync(output);
  return { root, workspace, shared, specs, output };
}

function createOpts(
  workingDir: string,
  extraDirs: string[],
  writableDirs: string[],
): MakerSessionCreateOpts {
  return {
    id: 'session-1',
    agentKind: 'codex',
    model: 'gpt-5.4',
    workingDir,
    extraDirs,
    writableDirs,
  };
}

describe('prepareDirectoryGrantsForBootstrap', () => {
  it('persists the complete applied subset when lazy bootstrap removes a nested writable grant', async () => {
    const { workspace, shared, specs, output } = makeGrantTree();
    const opts = createOpts(workspace, [specs], [shared, output]);
    const persistExistingSession = vi.fn(async () => {});

    await prepareDirectoryGrantsForBootstrap(opts, {
      readPersistedWritableDirs: async () => [shared, output],
      persistExistingSession,
    });

    expect(opts.extraDirs).toEqual([specs]);
    expect(opts.writableDirs).toEqual([output]);
    expect(persistExistingSession).toHaveBeenCalledWith('session-1', {
      extraDirs: [specs],
      writableDirs: [output],
    });
  });

  it('drops caller-supplied writable roots when no persisted session grant exists', async () => {
    const { root, workspace, shared, specs, output } = makeGrantTree();
    const sharedAlias = path.join(root, 'shared-alias');
    symlinkSync(shared, sharedAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const opts = createOpts(workspace, [specs], [sharedAlias, output]);
    const persistExistingSession = vi.fn(async () => {
      // Direct maker:create-session has no SQLite row until maker-core creates it.
    });

    await prepareDirectoryGrantsForBootstrap(opts, {
      readPersistedWritableDirs: async () => [],
      persistExistingSession,
    });

    expect(opts).toMatchObject({ extraDirs: [specs], writableDirs: [] });
    expect(persistExistingSession).not.toHaveBeenCalled();
  });

  it('replaces a caller-supplied writable root with the persisted grant before bootstrap', async () => {
    const { workspace, output } = makeGrantTree();
    const opts = createOpts(workspace, [], [workspace]);
    const persistExistingSession = vi.fn(async () => {});

    await prepareDirectoryGrantsForBootstrap(opts, {
      readPersistedWritableDirs: async () => [output],
      persistExistingSession,
    });

    expect(opts.writableDirs).toEqual([output]);
    expect(persistExistingSession).not.toHaveBeenCalled();
  });

  it('fails closed before runtime creation when narrowing the persisted grants fails', async () => {
    const { workspace, shared, specs } = makeGrantTree();
    const opts = createOpts(workspace, [specs], [shared]);

    await expect(
      prepareDirectoryGrantsForBootstrap(opts, {
        readPersistedWritableDirs: async () => [shared],
        persistExistingSession: vi.fn(async () => {
          throw new Error('sqlite unavailable');
        }),
      }),
    ).rejects.toThrow('sqlite unavailable');
  });

  it('keeps the narrowed subset stable across restart and does not rewrite it again', async () => {
    const { workspace, shared, specs, output } = makeGrantTree();
    let stored = { extraDirs: [specs], writableDirs: [shared, output] };
    const firstPersist = vi.fn(async (_sessionId: string, patch: typeof stored) => {
      stored = patch;
    });
    const firstBoot = createOpts(workspace, stored.extraDirs, stored.writableDirs);

    await prepareDirectoryGrantsForBootstrap(firstBoot, {
      readPersistedWritableDirs: async () => stored.writableDirs,
      persistExistingSession: firstPersist,
    });

    const restartPersist = vi.fn(async () => {});
    const restarted = createOpts(workspace, stored.extraDirs, stored.writableDirs);
    await prepareDirectoryGrantsForBootstrap(restarted, {
      readPersistedWritableDirs: async () => stored.writableDirs,
      persistExistingSession: restartPersist,
    });

    expect(stored).toEqual({ extraDirs: [specs], writableDirs: [output] });
    expect(restarted).toMatchObject(stored);
    expect(firstPersist).toHaveBeenCalledOnce();
    expect(restartPersist).not.toHaveBeenCalled();
  });

  it('does not write local SQLite for remote workspaces', async () => {
    const { workspace, shared, specs } = makeGrantTree();
    const opts = {
      ...createOpts(workspace, [specs], [shared]),
      remoteHostId: 'remote-host',
    };
    const persistExistingSession = vi.fn(async () => {});

    await prepareDirectoryGrantsForBootstrap(opts, {
      readPersistedWritableDirs: async () => [shared],
      persistExistingSession,
    });

    expect(opts.writableDirs).toEqual([]);
    expect(persistExistingSession).not.toHaveBeenCalled();
  });
});

describe('bootstrap directory-grant wiring', () => {
  it('persists the filtered subset before maker-core creates the runtime', () => {
    const registerSource = readFileSync(
      fileURLToPath(new URL('../register.ts', import.meta.url)),
      'utf8',
    );
    const bootstrapStart = registerSource.indexOf('async function bootstrapSession');
    const bootstrapEnd = registerSource.indexOf('\n  // switchFocus', bootstrapStart);
    const bootstrap = registerSource.slice(bootstrapStart, bootstrapEnd);

    expect(bootstrap.indexOf('await prepareDirectoryGrantsForBootstrap')).toBeGreaterThanOrEqual(0);
    expect(bootstrap.indexOf('await prepareDirectoryGrantsForBootstrap')).toBeLessThan(
      bootstrap.indexOf('await maker.createSession(o)'),
    );
    expect(bootstrap).toContain('if (existing) await persistSessionFields(sessionId, patch);');
    expect(bootstrap).toContain('readPersistedWritableDirs: readSessionWritableDirsFromDb');
  });
});
