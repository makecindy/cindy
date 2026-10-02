import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionInputFiles } from '../resources.js';
import type { SessionResourceRef } from '@cindy/maker-shared/session-controller';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Session file resources', () => {
  it('retains the target version across queue restoration and rejects later replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-controller-resources-')); roots.push(root);
    const file = path.join(root, 'report.txt'); await writeFile(file, 'target content');
    const ref: SessionResourceRef = { owningDeviceId: 'target', remoteHostId: null, kind: 'file', locator: file };
    const [accepted] = await resolveSessionInputFiles([ref], { deviceId: 'target', remoteHostId: null });
    const restored = JSON.parse(JSON.stringify(accepted));
    await expect(resolveSessionInputFiles([restored.sessionResource], { deviceId: 'target', remoteHostId: null })).resolves.toHaveLength(1);
    await writeFile(file, 'different target contents after restart');
    await expect(resolveSessionInputFiles([restored.sessionResource], { deviceId: 'target', remoteHostId: null })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('does not interpret a source-device or SSH path against an existing target file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-controller-resource-owner-')); roots.push(root);
    const file = path.join(root, 'same.txt'); await writeFile(file, 'target-only bytes');
    for (const namespace of [{ owningDeviceId: 'source', remoteHostId: null }, { owningDeviceId: 'target', remoteHostId: 'ssh' }]) {
      await expect(resolveSessionInputFiles([{ ...namespace, kind: 'file', locator: file }], { deviceId: 'target', remoteHostId: null }))
        .rejects.toMatchObject({ code: 'RESOURCE_UNREACHABLE' });
    }
  });
  it('rejects unavailable paths and directories as attachments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-controller-resource-type-')); roots.push(root);
    for (const locator of [root, path.join(root, 'absent')]) {
      await expect(resolveSessionInputFiles([{ owningDeviceId: 'target', remoteHostId: null, kind: 'file', locator }], { deviceId: 'target', remoteHostId: null }))
        .rejects.toMatchObject({ code: 'RESOURCE_UNREACHABLE' });
    }
  });
});
