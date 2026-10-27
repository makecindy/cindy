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
 *      protocolPrivileges.ts with every privilege constant in the array.
 */

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const readiness = vi.hoisted(() => ({ ready: false }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here', isReady: () => readiness.ready },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));
import { protocol } from 'electron';
import { registerDesktopSchemePrivileges, initializeAtElectronReady,
  cindyGhostSchemePrivilege, mcpAppSchemePrivilege } from '../protocolPrivileges';

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

// Production entry + observable initialization: packaged smoke hung before
// opening any DB after async startup registration. The old one-shot 'ready'
// listener missed an already-ready app. Existing value guards cannot see it.
// Minimal input: ready resolved before initializer registration. Tier: unit,
// fake Electron lifecycle, no process/profile/network or real timer.
describe('early declarations and late Electron ready', () => {
  it('rejects late scheme registration, then registers all schemes once without changing privileges', () => {
    readiness.ready = true;
    expect(() => registerDesktopSchemePrivileges()).toThrow('PROTOCOL_PRIVILEGES_REGISTERED_AFTER_READY');
    expect(protocol.registerSchemesAsPrivileged).not.toHaveBeenCalled();
    readiness.ready = false;
    registerDesktopSchemePrivileges(); registerDesktopSchemePrivileges();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const [schemes] = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0];
    expect(schemes.map(s => s.scheme)).toEqual(['cindy-desktop-capture', ...ALL.slice(0, 6).map(s => s.scheme), 'cindy-ghost', 'cindy-media', 'cindy-mcp-app']);
    expect(schemes.find(s => s.scheme === 'cindy-ghost')).toEqual(cindyGhostSchemePrivilege);
    expect(schemes.find(s => s.scheme === 'cindy-mcp-app')).toEqual(mcpAppSchemePrivilege);
    expect(cindyGhostSchemePrivilege.privileges).toEqual(imageSchemePrivilege.privileges);
    expect(mcpAppSchemePrivilege.privileges).toEqual({standard: true, secure: true, supportFetchAPI: true, corsEnabled: true});
  });
  it('initializes once if ready happened before registration', async () => {
    const initialize = vi.fn(() => 'initialized');
    await expect(initializeAtElectronReady({whenReady: () => Promise.resolve()}, initialize)).resolves.toBe('initialized');
    expect(initialize).toHaveBeenCalledTimes(1);
  });
  it('still waits for Electron when not ready yet', async () => {
    let ready!: () => void;
    const wait = new Promise<void>(resolve => { ready = resolve; });
    const initialize = vi.fn();
    const result = initializeAtElectronReady({whenReady: () => wait}, initialize);
    await Promise.resolve(); expect(initialize).not.toHaveBeenCalled();
    ready(); await result; expect(initialize).toHaveBeenCalledTimes(1);
  });
});

describe('registerSchemesAsPrivileged is called exactly once (static scan)', () => {
  const MAIN_DIR = path.resolve(__dirname, '..');

  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name === '__tests__' || name === 'node_modules') continue;
      const p = path.join(dir, name);
      if (entry.isDirectory() || (!entry.isFile() && statSync(p).isDirectory())) {
        out.push(...collectTsFiles(p));
      } else if (name.endsWith('.ts')) {
        out.push(p);
      }
    }
    return out;
  }

  // Match the actual invocation (receiver included) so doc comments that
  // merely mention the API name don't count as call sites.
  const CALL = 'protocol.registerSchemesAsPrivileged(';

  it('single call site lives in protocolPrivileges.ts with all schemes', () => {
    const callSites: string[] = [];
    let startupSource = '';
    for (const file of collectTsFiles(MAIN_DIR)) {
      const src = readFileSync(file, 'utf8');
      if (path.basename(file) === 'bootstrap-electron.ts') startupSource = src;
      let idx = src.indexOf(CALL);
      while (idx !== -1) {
        callSites.push(file);
        idx = src.indexOf(CALL, idx + 1);
      }
    }

    expect(callSites).toHaveLength(1);
    expect(path.basename(callSites[0])).toBe('protocolPrivileges.ts');

    const bootstrapSrc = readFileSync(callSites[0], 'utf8');
    const callStart = bootstrapSrc.indexOf(CALL);
    const callBlock = bootstrapSrc.slice(callStart, callStart + 650);
    for (const name of [
      'imageSchemePrivilege',
      'videoSchemePrivilege',
      'localFileSchemePrivilege',
      'audioFileSchemePrivilege',
      'modelSchemePrivilege',
      'remoteMediaSchemePrivilege',
      'cindyMediaSchemePrivilege',
      'cindyGhostSchemePrivilege',
      'mcpAppSchemePrivilege',
    ]) {
      expect(callBlock).toContain(name);
    }
    // Security boundary: real packaged smoke cannot persist an OS default URL
    // handler outside its scratch profile. Reuse this existing cross-file scan.
    expect(startupSource).toContain('if (!isCindyPersonalRuntime() && !parseSmokeArgs().enabled) registerDeepLinkProtocol();');
  });
});
