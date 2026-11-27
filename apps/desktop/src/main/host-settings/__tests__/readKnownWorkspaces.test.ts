import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionInspectionOptions } from '../readers/collections.js';

const mocks = vi.hoisted(() => ({
  sessions: [] as unknown[],
  ready: true,
  getMakerIfReady: vi.fn(),
  listActiveSessions: vi.fn(),
  forbidden: vi.fn(() => { throw new Error('No initialization, database, disk, auth, or network access'); }),
}));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: mocks.getMakerIfReady, getMaker: mocks.forbidden }));
vi.mock('node:fs', () => ({
  readFileSync: mocks.forbidden, readdirSync: mocks.forbidden, statSync: mocks.forbidden,
  realpathSync: mocks.forbidden, existsSync: mocks.forbidden, mkdirSync: mocks.forbidden,
  writeFileSync: mocks.forbidden, promises: { readdir: mocks.forbidden, readFile: mocks.forbidden },
}));
vi.mock('electron', () => ({ app: { getPath: mocks.forbidden }, safeStorage: { decryptString: mocks.forbidden } }));
vi.mock('../../authManager.js', () => ({ getAuthState: mocks.forbidden, getAccessToken: mocks.forbidden }));

import { readKnownWorkspaces } from '../readKnownWorkspaces.js';

// Recorded before any test resets the mocks: importing the module must not inspect anything.
const callsDuringImport = [mocks.getMakerIfReady, mocks.listActiveSessions, mocks.forbidden]
  .map((spy) => spy.mock.calls.length);

const firstDir = path.resolve('/memory-only-project-one');
const secondDir = path.resolve('/memory-only-project-two');
const local = (workDir: string) => ({ workDir, remoteHostId: null });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessions = [];
  mocks.ready = true;
  mocks.forbidden.mockImplementation(() => { throw new Error('No initialization, database, disk, auth, or network access'); });
  mocks.listActiveSessions.mockImplementation(() => mocks.sessions);
  mocks.getMakerIfReady.mockImplementation(() => mocks.ready ? {
    listActiveSessions: mocks.listActiveSessions,
    listAllMeta: mocks.forbidden,
    getSessionMeta: mocks.forbidden,
    storage: { list: mocks.forbidden },
  } : null);
  vi.stubGlobal('fetch', mocks.forbidden);
});
afterEach(() => {
  expect(mocks.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('in-memory known workspace observation', () => {
  it('does not inspect Maker, paths, or sessions at module import time', () => {
    expect(callsDuringImport.every((calls) => calls === 0)).toBe(true);
  });

  it('returns an incomplete empty scope without constructing an unready Maker', () => {
    mocks.ready = false;
    expect(readKnownWorkspaces()).toEqual({ knownWorkspaces: [], knownWorkspacesComplete: false });
    expect(mocks.getMakerIfReady).toHaveBeenCalledTimes(1);
    expect(mocks.listActiveSessions).not.toHaveBeenCalled();
  });

  it('never describes an empty active-session list as full workspace coverage', () => {
    expect(readKnownWorkspaces()).toEqual({ knownWorkspaces: [], knownWorkspacesComplete: false });
    expect(mocks.listActiveSessions).toHaveBeenCalledTimes(1);
  });

  it('deduplicates local absolute workdirs in first-observed order without filesystem resolution', () => {
    mocks.sessions = [local(firstDir), local(firstDir), local(secondDir), local(firstDir)];
    const result: Pick<CollectionInspectionOptions, 'knownWorkspaces' | 'knownWorkspacesComplete'> = readKnownWorkspaces();
    expect(result).toEqual({ knownWorkspaces: [firstDir, secondDir], knownWorkspacesComplete: false });
    expect(mocks.listActiveSessions).toHaveBeenCalledTimes(1);
  });

  it('filters remote and unknown-location sessions, even if the remote path is locally absolute', () => {
    mocks.sessions = [
      { workDir: firstDir, remoteHostId: 'remote-host' },
      { workDir: firstDir, remoteHostId: undefined },
      { workDir: firstDir },
      { workDir: firstDir, remoteHostId: '' },
      local(secondDir),
    ];
    expect(readKnownWorkspaces()).toEqual({ knownWorkspaces: [secondDir], knownWorkspacesComplete: false });
  });

  it.each(['', '.', '..', 'relative-project', 'relative/project', '~/project'])('does not resolve non-absolute workdir %j', (workDir) => {
    mocks.sessions = [local(workDir), local(firstDir)];
    expect(readKnownWorkspaces()).toEqual({ knownWorkspaces: [firstDir], knownWorkspacesComplete: false });
  });

  it('rejects non-string and NUL-containing workdirs', () => {
    mocks.sessions = [
      { workDir: null, remoteHostId: null }, { workDir: 42, remoteHostId: null },
      { workDir: {}, remoteHostId: null }, local(`${firstDir}\0suffix`), local(secondDir),
    ];
    expect(readKnownWorkspaces()).toEqual({ knownWorkspaces: [secondDir], knownWorkspacesComplete: false });
  });

  it('does not canonicalize absolute paths through potentially meaningful symlink components', () => {
    const lexicalPath = `${firstDir}${path.sep}link${path.sep}..${path.sep}project`;
    mocks.sessions = [local(lexicalPath)];
    expect(readKnownWorkspaces().knownWorkspaces).toEqual([lexicalPath]);
  });

  it('returns a fresh snapshot without changing session objects or retaining a cache', () => {
    const session = Object.freeze(local(firstDir));
    mocks.sessions = [session];
    const first = readKnownWorkspaces();
    mocks.sessions = [local(secondDir)];
    expect(readKnownWorkspaces().knownWorkspaces).toEqual([secondDir]);
    expect(first.knownWorkspaces).toEqual([firstDir]);
    expect(session).toEqual(local(firstDir));
  });

  it.each(['maker', 'sessions', 'field'] as const)('fails closed on %s exceptions without disk fallback or private error details', (kind) => {
    const fail = () => { throw new Error('private owner and directory detail'); };
    if (kind === 'maker') mocks.getMakerIfReady.mockImplementation(fail);
    if (kind === 'sessions') mocks.listActiveSessions.mockImplementation(fail);
    if (kind === 'field') mocks.sessions = [local(firstDir), { remoteHostId: null, get workDir() { return fail(); } }];
    expect(readKnownWorkspaces()).toEqual({ knownWorkspaces: [], knownWorkspacesComplete: false });
  });
});
