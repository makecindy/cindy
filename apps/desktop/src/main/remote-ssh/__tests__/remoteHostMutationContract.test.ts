import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

function handlerBody(channel: string, nextChannel: string): string {
  const start = source.indexOf(`ipcMain.handle(REMOTE_SSH_INVOKE.${channel}`);
  const end = source.indexOf(`ipcMain.handle(REMOTE_SSH_INVOKE.${nextChannel}`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('remote SSH managed-host mutation contract', () => {
  it.each([
    ['LIST', 'RELOAD_CONFIG'],
    ['RELOAD_CONFIG', 'ADD'],
  ])('%s validates the app renderer before reading SSH config', (channel, nextChannel) => {
    const body = handlerBody(channel, nextChannel);
    const guard = body.indexOf('assertTrustedAppRendererEvent(event);');
    const read = Math.min(
      ...[
        body.indexOf('ensureHydrated()'),
        body.indexOf('hydrateRemoteHosts()'),
      ].filter((index) => index >= 0),
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(read);
  });

  it.each([
    ['ADD', 'UPDATE'],
    ['UPDATE', 'REMOVE'],
    ['REMOVE', 'CONNECT'],
  ])('%s validates the app renderer before parsing input', (channel, nextChannel) => {
    const body = handlerBody(channel, nextChannel);
    const guard = body.indexOf('assertTrustedAppRendererEvent(event);');
    const parse = Math.min(
      ...[
        body.indexOf('normalizeAddInput('),
        body.indexOf('requireObject('),
      ].filter((index) => index >= 0),
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(parse);
  });

  it('serializes add, update, and remove with config reloads', () => {
    for (const [channel, nextChannel] of [
      ['ADD', 'UPDATE'],
      ['UPDATE', 'REMOVE'],
      ['REMOVE', 'CONNECT'],
    ]) {
      expect(handlerBody(channel, nextChannel))
        .toContain('return remoteHostHydrationQueue.run(async () => {');
    }
  });

  it('does not disconnect existing aliases when an add write or refresh fails', () => {
    const body = handlerBody('ADD', 'UPDATE');
    const hostWrite = body.indexOf('await addManagedHostWithInclude(');
    const hydrate = body.indexOf('await hydrateRemoteHostsUnqueued(new Set(), true, new Set([cfg.id]));');
    const reloadError = body.indexOf("throwReloadRequired('新主机'");

    expect(hostWrite).toBeGreaterThan(-1);
    expect(hydrate).toBeGreaterThan(hostWrite);
    expect(reloadError).toBeGreaterThan(hydrate);
    expect(body).not.toContain('invalidateHostRuntimeState(');
    expect(body).not.toContain('.disconnect(');
    expect(source).toContain('if (preserveExistingEndpoints && changedOrRemoved.length > 0)');
  });

  it('checks ownership before publishing a hydrated pool and rolls back add conflicts', () => {
    const hydrateSource = source.slice(
      source.indexOf('async function hydrateRemoteHostsUnqueued('),
      source.indexOf('function hydrateRemoteHosts()', source.indexOf('async function hydrateRemoteHostsUnqueued(')),
    );
    const ownershipCheck = hydrateSource.indexOf('requiredManagedAliases');
    const poolPublish = hydrateSource.indexOf('await getPool().hydrate(result.hosts);');
    expect(ownershipCheck).toBeGreaterThan(-1);
    expect(ownershipCheck).toBeLessThan(poolPublish);

    const body = handlerBody('ADD', 'UPDATE');
    const hydrate = body.indexOf('await hydrateRemoteHostsUnqueued(new Set(), true, new Set([cfg.id]));');
    const rollback = body.indexOf('await addReceipt.rollback();');
    const prefs = body.indexOf('patchSshHostPrefOrThrow(cfg.id');
    expect(rollback).toBeGreaterThan(hydrate);
    expect(rollback).toBeLessThan(prefs);
    expect(body).toContain('instanceof SshHostOwnershipConflictError');
  });

  it('rejects external connection-field edits and writes before invalidating an owned endpoint', () => {
    const body = handlerBody('UPDATE', 'REMOVE');
    const diskRead = body.indexOf('const latest = await readLatestSshConfigOrThrow();');
    const readOnlyGuard = body.indexOf('if (!latestHost?.managedByCindy)');
    const write = body.indexOf('await updateManagedHostFields(');
    const invalidate = body.indexOf('await invalidateHostRuntimeState(input.id);');
    const hydrate = body.indexOf('await hydrateRemoteHostsUnqueued(new Set([input.id]));');

    expect(diskRead).toBeGreaterThan(-1);
    expect(readOnlyGuard).toBeGreaterThan(diskRead);
    expect(readOnlyGuard).toBeLessThan(write);
    expect(body).toContain('managedWriteTokenOrThrow(latest)');
    expect(body).toContain('managedSshConfigPath, managedWriteToken!');
    expect(write).toBeLessThan(invalidate);
    expect(invalidate).toBeLessThan(hydrate);
  });

  it('writes a remove before disconnecting the target and never deletes external hosts', () => {
    const body = handlerBody('REMOVE', 'CONNECT');
    const diskRead = body.indexOf('const latest = await readLatestSshConfigOrThrow();');
    const ownershipGuard = body.indexOf('if (!latestHost?.managedByCindy)');
    const write = body.indexOf('await removeManagedHost(');
    const invalidate = body.indexOf('await invalidateHostRuntimeState(id);');
    const hydrate = body.indexOf('await hydrateRemoteHostsUnqueued(new Set([id]));');

    expect(diskRead).toBeGreaterThan(-1);
    expect(ownershipGuard).toBeGreaterThan(diskRead);
    expect(ownershipGuard).toBeLessThan(write);
    expect(body).toContain('const managedWriteToken = managedWriteTokenOrThrow(latest);');
    expect(body).toContain('managedSshConfigPath, managedWriteToken');
    expect(write).toBeLessThan(invalidate);
    expect(invalidate).toBeLessThan(hydrate);
  });

  it('uses managed ownership instead of the legacy manual source marker', () => {
    const mutationSource = source.slice(
      source.indexOf('ipcMain.handle(REMOTE_SSH_INVOKE.ADD'),
      source.indexOf('ipcMain.handle(REMOTE_SSH_INVOKE.CONNECT'),
    );
    expect(mutationSource).not.toContain("source === 'manual'");
    expect(mutationSource).toContain('managedByCindy');
  });
});
