import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActiveAppSession } from '../../appSessionState.js';
import {
  abandonForgePackInstall,
  consumeForgePackAtInspect,
  consumeForgePackAtInstall,
} from '../forgePackConsume.js';
import {
  createForgePackStagingController,
  sha256Hex,
} from '../forgePackStaging.js';

const OWNER: ActiveAppSession = {
  mode: 'cloud',
  dataOwnerId: 'user-a',
  generation: 1,
};

const OTHER: ActiveAppSession = {
  mode: 'cloud',
  dataOwnerId: 'user-b',
  generation: 2,
};

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeController() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-forge-consume-'));
  let n = 0;
  return createForgePackStagingController({
    getTempDir: () => tempDir!,
    randomId: () => `id-${n++}`,
    scheduleTimeout: () => ({ cancel() {} }),
  });
}

describe('consumeForgePackAtInspect / consumeForgePackAtInstall', () => {
  it('accepts matching hash and manifest id, then refuses a second inspect', () => {
    const controller = makeController();
    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    const first = consumeForgePackAtInspect(controller, {
      filePath: staged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(first.kind).toBe('accepted');
    const second = consumeForgePackAtInspect(controller, {
      filePath: staged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(second).toEqual({ kind: 'rejected', reason: 'ticket-replay' });
  });

  it('invalidates the ticket when inspect hash or manifest id mismatches', () => {
    const controller = makeController();
    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    const rejected = consumeForgePackAtInspect(controller, {
      filePath: staged.stagingPath,
      packageSha256: 'b'.repeat(64),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(rejected).toEqual({ kind: 'rejected', reason: 'ticket-binding-mismatch' });
    expect(fs.existsSync(staged.stagingPath)).toBe(false);
    expect(
      consumeForgePackAtInspect(controller, {
        filePath: staged.stagingPath,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'not-forge' });
  });

  it('refuses inspect while the session boundary is pending without consuming the ticket', () => {
    const controller = makeController();
    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    expect(
      consumeForgePackAtInspect(controller, {
        filePath: staged.stagingPath,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: true,
      }),
    ).toEqual({ kind: 'rejected', reason: 'session-boundary-pending' });
    expect(fs.existsSync(staged.stagingPath)).toBe(true);
    expect(
      consumeForgePackAtInspect(controller, {
        filePath: staged.stagingPath,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }).kind,
    ).toBe('accepted');
  });

  it('refuses install while the session boundary is pending without consuming the continuation', () => {
    const controller = makeController();
    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    const inspected = consumeForgePackAtInspect(controller, {
      filePath: staged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(inspected.kind).toBe('accepted');
    if (inspected.kind !== 'accepted') return;
    expect(
      consumeForgePackAtInstall(controller, {
        packTicket: inspected.packTicket,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: true,
      }),
    ).toEqual({ kind: 'rejected', reason: 'session-boundary-pending' });
    expect(
      consumeForgePackAtInstall(controller, {
        packTicket: inspected.packTicket,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }).kind,
    ).toBe('agent-forge');
  });

  it('lets install proceed as update even when the pack ticket said install', () => {
    const controller = makeController();
    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    const inspected = consumeForgePackAtInspect(controller, {
      filePath: staged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(inspected.kind).toBe('accepted');
    if (inspected.kind !== 'accepted') return;
    const installed = consumeForgePackAtInstall(controller, {
      packTicket: inspected.packTicket,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(installed.kind).toBe('agent-forge');
    if (installed.kind !== 'agent-forge') return;
    expect(installed.ticket.operationKind).toBe('install');
    expect(installed.ticket.manifestId).toBe('demo');
  });

  it('treats a missing pack ticket as manual and refuses replay of a consumed continuation', () => {
    const controller = makeController();
    expect(
      consumeForgePackAtInstall(controller, {
        packTicket: undefined,
        packageSha256: 'a'.repeat(64),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'manual' });

    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'update',
    });
    const inspected = consumeForgePackAtInspect(controller, {
      filePath: staged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(inspected.kind).toBe('accepted');
    if (inspected.kind !== 'accepted') return;
    expect(
      consumeForgePackAtInstall(controller, {
        packTicket: inspected.packTicket,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }).kind,
    ).toBe('agent-forge');
    expect(
      consumeForgePackAtInstall(controller, {
        packTicket: inspected.packTicket,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'ticket-replay' });
  });

  it('refuses inspect continuation when the process freezes past the pack hard deadline', () => {
    const t1 = 1_700_000_000_000;
    const ttlMs = 10 * 60 * 1000;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-forge-consume-'));
    let afterStage = false;
    let inspectNowCalls = 0;
    let n = 0;
    const controller = createForgePackStagingController({
      getTempDir: () => tempDir!,
      ttlMs,
      randomId: () => `id-${n++}`,
      scheduleTimeout: () => ({ cancel() {} }),
      now: () => {
        if (!afterStage) return t1;
        inspectNowCalls += 1;
        // First now() is the pack expiry check (still live). Later now() is
        // issueInstallContinuation after a 30-minute freeze.
        return inspectNowCalls === 1 ? t1 + ttlMs - 1_000 : t1 + ttlMs - 1_000 + 30 * 60 * 1000;
      },
    });
    const buf = Buffer.from('pkg-bytes');
    const staged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    afterStage = true;
    expect(
      consumeForgePackAtInspect(controller, {
        filePath: staged.stagingPath,
        packageSha256: sha256Hex(buf),
        manifestId: 'demo',
        currentOwner: OWNER,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'ticket-expired' });
    expect(fs.existsSync(staged.stagingPath)).toBe(false);
    expect(inspectNowCalls).toBeGreaterThanOrEqual(2);
  });

  it('cleans staging on cancel, success, and reject', () => {
    const controller = makeController();
    const buf = Buffer.from('pkg-bytes');
    const cancelStaged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    const cancelInspect = consumeForgePackAtInspect(controller, {
      filePath: cancelStaged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(cancelInspect.kind).toBe('accepted');
    if (cancelInspect.kind !== 'accepted') return;
    abandonForgePackInstall(controller, cancelInspect.packTicket);
    expect(fs.existsSync(cancelStaged.stagingPath)).toBe(false);

    const successStaged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    const successInspect = consumeForgePackAtInspect(controller, {
      filePath: successStaged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(successInspect.kind).toBe('accepted');
    if (successInspect.kind !== 'accepted') return;
    const successInstall = consumeForgePackAtInstall(controller, {
      packTicket: successInspect.packTicket,
      packageSha256: sha256Hex(buf),
      manifestId: 'demo',
      currentOwner: OWNER,
      boundaryPending: false,
    });
    expect(successInstall.kind).toBe('agent-forge');
    if (successInstall.kind !== 'agent-forge') return;
    controller.releaseStaging(successInstall.ticket.stagingPath);
    expect(fs.existsSync(successStaged.stagingPath)).toBe(false);

    const rejectStaged = controller.stage({
      buf,
      manifestId: 'demo',
      owner: OWNER,
      operationKind: 'install',
    });
    consumeForgePackAtInspect(controller, {
      filePath: rejectStaged.stagingPath,
      packageSha256: sha256Hex(buf),
      manifestId: 'other',
      currentOwner: OTHER,
      boundaryPending: false,
    });
    expect(fs.existsSync(rejectStaged.stagingPath)).toBe(false);
  });
});
