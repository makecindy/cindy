/**
 * Regression for the circular import through the provider-share availability policy.
 * The adjacent settings and remote-model tests stub the policy or its transport,
 * so they cannot exercise the production import order. Keep the policy import first.
 * Unit: the two public save operations must reject when the share registry is
 * unreadable. An isolated temporary profile replaces any real account data.
 */
import '../providerShareAvailabilityPolicy.js';
import { writeDeviceLinkSetting } from '../settings-store.desktop.js';
import { remoteModelAccess } from '../remoteModelAccess.js';
import { ownerScopedUserDataPath } from '../../appSessionState.js';
import { configureUserDataDir, getUserDataDir } from '../../userDataPath.js';
import { app } from 'electron';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

let profile: string | undefined;
let previousProfile: string;

beforeAll(async () => {
  previousProfile = getUserDataDir();
  const tempProfile = await mkdtemp(path.join(os.tmpdir(), 'cindy-availability-policy-'));
  profile = tempProfile;
  const originalGetPath = app.getPath.bind(app);
  vi.spyOn(app, 'getPath').mockImplementation((name) =>
    name === 'userData' ? tempProfile : originalGetPath(name));
  configureUserDataDir(tempProfile);
  // Signed-out owner storage also uses the OS temp directory as a fallback.
  vi.spyOn(os, 'tmpdir').mockReturnValue(tempProfile);

  const registry = ownerScopedUserDataPath('provider-share-availability.json');
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, 'invalid JSON');
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (profile) {
    configureUserDataDir(previousProfile);
    await rm(profile, { recursive: true, force: true });
  }
});

it('checks the share registry before saving a remote-control setting', async () => {
  await expect(writeDeviceLinkSetting('remoteControlEnabled', false))
    .rejects.toThrow('Shared standby registrations could not be read');
});

it('checks the share registry before saving remote-model permissions', async () => {
  await expect(remoteModelAccess.set('openai', [], undefined, () => {}))
    .rejects.toThrow('Shared standby registrations could not be read');
});
