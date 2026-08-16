import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  root: '',
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  ownerId: 'owner-a' as string | null,
  ownerGeneration: 1,
  boundaryPending: false,
  exclusive: true,
  listeners: new Map<string, (event: { returnValue?: unknown }) => void>(),
  assertTrusted: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.root },
  ipcMain: {
    on: (channel: string, listener: (event: { returnValue?: unknown }) => void) => {
      harness.listeners.set(channel, listener);
    },
  },
}));

vi.mock('../../appSessionState.js', () => ({
  dataOwnerStorageKey: (ownerId: string) => `key-${ownerId}`,
  getActiveAppSession: () => ({
    mode: harness.mode,
    dataOwnerId: harness.ownerId,
  }),
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: harness.ownerId,
    ownerGeneration: harness.ownerGeneration,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: () => harness.exclusive,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
}));

import {
  claimLegacyModelVisibilityOwner,
  registerModelVisibilityOwnerClaimIpc,
} from '../model-visibility-owner-claim.js';

const markerName = 'model-visibility-renderer-legacy-owner.v1.json';

beforeEach(() => {
  harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-model-visibility-owner-'));
  harness.mode = 'cloud';
  harness.ownerId = 'owner-a';
  harness.ownerGeneration = 1;
  harness.boundaryPending = false;
  harness.exclusive = true;
  harness.listeners.clear();
  harness.assertTrusted.mockClear();
});

afterEach(() => {
  fs.rmSync(harness.root, { recursive: true, force: true });
});

describe('model visibility legacy Renderer owner claim', () => {
  it('atomically binds the legacy key to the active stable owner only once', () => {
    expect(claimLegacyModelVisibilityOwner()).toEqual({
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(harness.root, markerName), 'utf-8'))).toEqual({
      version: 1,
      ownerKey: 'key-owner-a',
    });

    harness.ownerId = 'owner-b';
    harness.ownerGeneration = 2;
    expect(claimLegacyModelVisibilityOwner()).toEqual({
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      claimed: false,
      claimedByOtherOwner: true,
      canInitialize: false,
    });
  });

  it('lets a stable local profile claim the legacy key before a later cloud login', () => {
    harness.mode = 'local';
    harness.ownerId = 'local-v1';
    expect(claimLegacyModelVisibilityOwner()).toMatchObject({
      dataOwnerId: 'local-v1',
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: true,
    });
    harness.mode = 'cloud';
    harness.ownerId = 'owner-a';
    expect(claimLegacyModelVisibilityOwner()).toMatchObject({
      claimed: false,
      claimedByOtherOwner: true,
      canInitialize: false,
    });
  });

  it('does not claim from signed-out, boundary-pending, or shared access', () => {
    harness.mode = 'signed-out';
    harness.ownerId = null;
    expect(claimLegacyModelVisibilityOwner().claimed).toBe(false);
    harness.mode = 'cloud';
    harness.ownerId = 'owner-a';
    harness.boundaryPending = true;
    expect(claimLegacyModelVisibilityOwner().claimed).toBe(false);
    harness.boundaryPending = false;
    harness.exclusive = false;
    expect(claimLegacyModelVisibilityOwner().claimed).toBe(false);
    expect(fs.existsSync(path.join(harness.root, markerName))).toBe(false);
  });

  it('registers the trusted synchronous claim handler in the eager bootstrap phase', () => {
    registerModelVisibilityOwnerClaimIpc();
    const listener = harness.listeners.get('maker:model-visibility:legacy-owner-claim-sync');
    expect(listener).toBeDefined();
    const event: { returnValue?: unknown } = {};
    listener?.(event);
    expect(harness.assertTrusted).toHaveBeenCalledWith(event);
    expect(event.returnValue).toMatchObject({ dataOwnerId: 'owner-a', claimed: true });
  });

  it('keeps a claimed owner readable but blocks legacy initialization without exclusivity', () => {
    expect(claimLegacyModelVisibilityOwner().canInitialize).toBe(true);
    harness.exclusive = false;
    expect(claimLegacyModelVisibilityOwner()).toMatchObject({
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: false,
    });
  });

  it('fails closed instead of replacing a malformed marker', () => {
    fs.writeFileSync(path.join(harness.root, markerName), '{broken', 'utf-8');
    expect(claimLegacyModelVisibilityOwner()).toMatchObject({
      claimed: false,
      claimedByOtherOwner: false,
      canInitialize: false,
    });
    expect(fs.readFileSync(path.join(harness.root, markerName), 'utf-8')).toBe('{broken');
  });
});
