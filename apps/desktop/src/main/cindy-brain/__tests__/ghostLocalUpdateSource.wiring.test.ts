import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

function bodyBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('local update production source gate wiring', () => {
  it('rechecks approved source and broker eligibility under the install lock before stopping the old runtime', () => {
    const body = bodyBetween('async function updateLocalGhostPackageLocked(', 'export async function installOrUpdateLocalGhostPackageFromForge(');
    const classify = body.indexOf('readLocalGhostUpdateSource(');
    const gate = body.indexOf('rejectUnauthorizedTokenBroker(inspected.canonicalManifest, authorizationOverrides)');
    const stop = body.indexOf('runtime.stop(');
    expect(classify).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(classify);
    expect(stop).toBeGreaterThan(gate);
    expect(body).toContain('sourceChanged ? { sourceStateArchiveId: ghostSourceStateArchiveId(previousGhost) }');
  });

  it('never borrows the old market or builtin trust for the newly inspected local package', () => {
    const body = bodyBetween('function readLocalGhostUpdateSource(', 'async function updateLocalGhostPackageLocked(');
    expect(body).toContain('manager.readApprovedInstallReceipt(instanceId, previousGhost.approval.revision)');
    expect(body).toContain('classifyGhostLocalUpdateSource({');
    expect(body).toContain('packageSha256: inspected.packageSha256');
    expect(body).toContain('trust: inspected.trust');
    expect(body).toContain('marketRecord: null');
    expect(body).toContain('trustedSource: null');
    expect(body).toContain('legacyFirstPartyEligible: decision.legacyFirstPartyEligible');
  });

  it('checks the selected local update target before computing its legacy gate override', () => {
    const target = source.indexOf('const existingForUpdate = findInstalledGhostForLocalUpdate(');
    const classify = source.indexOf('const updateSource = readLocalGhostUpdateSource(', target);
    const gate = source.indexOf('rejectUnauthorizedTokenBroker(inspected.canonicalManifest, updateSource.authorizationOverrides)', target);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(classify).toBeGreaterThan(target);
    expect(gate).toBeGreaterThan(classify);
    expect(source.slice(target, gate)).toContain("if (!existingForUpdate) throwIpcError('PRECONDITION_FAILED'");
  });

  it('uses the same source decision for Forge updates before entering the common locked transaction', () => {
    const body = bodyBetween('export async function installOrUpdateLocalGhostPackageFromForge(', 'export async function installOrUpdateMarketGhostPackage(');
    expect(body).toContain('readLocalGhostUpdateSource(manager, existingForForge, inspected, installOrigin).authorizationOverrides');
    expect(body).toContain('ghost: await updateLocalGhostPackageLocked(');
  });
});
