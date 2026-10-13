/**
 * schemePrivileges.test.ts
 * ---------------------------------------------------------------------------
 * Regression guard for the custom-scheme privilege registration model.
 *
 * Electron's protocol.registerSchemesAsPrivileged REPLACES the entire
 * privileged-scheme list on every call — it must be called exactly once, with
 * every scheme collected. We shipped the bug once: each protocol module used
 * to self-register, so only the last caller (cindy-remote-media, added
 * 2026-06-16) kept its privileges and xdt-model lost supportFetchAPI →
 * <model-viewer>'s fetch() was rejected → 3D preview silently stuck on its
 * poster image.
 *
 * Two layers of defense:
 *   1. Value assertions on each exported privilege constant (scheme name +
 *      every field, supportFetchAPI in particular).
 *   2. Static source scan: `registerSchemesAsPrivileged(` appears exactly
 *      once under src/main/**, and that one occurrence is in
 *      bootstrap-electron.ts with all six privilege constants in the array.
 */

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

// remoteMediaProtocol pulls in device-link runtime deps; stub the boundary
// modules so importing the privilege constant stays side-effect free.
vi.mock('../device-link/index', () => ({ remoteInvoke: vi.fn() }));
vi.mock('../device-link/filePeer', () => ({ tryPeerFile: vi.fn(async () => null) }));
vi.mock('../device-link/mediaTransfer', () => ({
  downloadToBuffer: vi.fn(),
  openMediaStream: vi.fn(),
  removeRemote: vi.fn(),
}));

const { imageSchemePrivilege } = await import('../imageProtocol');
const { videoSchemePrivilege } = await import('../videoProtocol');
const { localFileSchemePrivilege } = await import('../localFileProtocol');
const { audioFileSchemePrivilege } = await import('../audioFileProtocol');
const { modelSchemePrivilege } = await import('../modelProtocol');
const { remoteMediaSchemePrivilege } = await import(
  '../device-link/remoteMediaProtocol'
);
const { cindyMediaSchemePrivilege } = await import(
  '../cindy-media/cindyMediaProtocol'
);

const ALL = [
  { entry: imageSchemePrivilege, scheme: 'xdt-image' },
  { entry: videoSchemePrivilege, scheme: 'xdt-video' },
  { entry: localFileSchemePrivilege, scheme: 'xdt-file' },
  { entry: audioFileSchemePrivilege, scheme: 'xdt-audio' },
  { entry: modelSchemePrivilege, scheme: 'xdt-model' },
  { entry: remoteMediaSchemePrivilege, scheme: 'cindy-remote-media' },
  { entry: cindyMediaSchemePrivilege, scheme: 'cindy-media' },
];

describe('scheme privilege constants', () => {
  it.each(ALL)('$scheme keeps the full privilege set', ({ entry, scheme }) => {
    expect(entry.scheme).toBe(scheme);
    expect(entry.privileges).toEqual({
      standard: true,
      secure: true,
      // Load-bearing for xdt-model (<model-viewer> fetch) and xdt-file
      // (FBXLoader / drawio viewer fetch); kept true everywhere.
      supportFetchAPI: true,
      bypassCSP: false,
      stream: false,
      corsEnabled: false,
    });
  });
});

describe('registerSchemesAsPrivileged is called exactly once (static scan)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../../..');

  // Match the actual invocation (receiver included) so doc comments that
  // merely mention the API name don't count as call sites.
  const CALL = 'protocol.registerSchemesAsPrivileged(';

  it('single call site lives in bootstrap-electron.ts with all six schemes', () => {
    const callSites = execFileSync(
      'git',
      ['grep', '-l', '-F', CALL, '--', 'apps/desktop/src/main'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'))
      .map((file) => path.join(REPO_ROOT, file));

    expect(callSites).toHaveLength(1);
    expect(path.basename(callSites[0])).toBe('bootstrap-electron.ts');

    const bootstrapSrc = readFileSync(callSites[0], 'utf8');
    const callStart = bootstrapSrc.indexOf(CALL);
    const callBlock = bootstrapSrc.slice(callStart, callStart + 400);
    for (const name of [
      'imageSchemePrivilege',
      'videoSchemePrivilege',
      'localFileSchemePrivilege',
      'audioFileSchemePrivilege',
      'modelSchemePrivilege',
      'remoteMediaSchemePrivilege',
      'cindyMediaSchemePrivilege',
    ]) {
      expect(callBlock).toContain(name);
    }
  }, 30_000);
});
