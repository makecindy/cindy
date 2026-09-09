import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  root: '',
  session: {
    dataOwnerId: 'owner-a' as string | null,
    generation: 1,
  },
  boundaryPending: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  untrustedSend: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  assertTrusted: vi.fn(),
  isDeviceLinkInvoke: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.root },
  BrowserWindow: {
    getAllWindows: () => [
      { appContent: true, isDestroyed: () => false, webContents: { send: harness.send } },
      { appContent: false, isDestroyed: () => false, webContents: { send: harness.untrustedSend } },
    ],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `cloud:${harness.session.dataOwnerId ?? 'none'}:${harness.session.generation}`,
  getActiveAppSession: () => ({
    mode: 'cloud',
    dataOwnerId: harness.session.dataOwnerId,
    generation: harness.session.generation,
  }),
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: harness.session.dataOwnerId,
    ownerGeneration: harness.session.generation,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(harness.root, 'owners', `key-${harness.session.dataOwnerId ?? 'none'}`, ...parts),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
}));

vi.mock('../windowFocusClassifier.js', () => ({
  isAppContentWindow: (window: { appContent?: boolean; isDestroyed: () => boolean }) =>
    window.appContent === true && !window.isDestroyed(),
}));

vi.mock('../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: (...args: unknown[]) => harness.tapWindowBroadcast(...args),
}));

vi.mock('../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: () => harness.isDeviceLinkInvoke,
}));

async function getHandler(payload?: unknown) {
  const handler = harness.handlers.get('sidebar-settings:get-project-order');
  expect(handler).toBeDefined();
  return handler?.({}, payload);
}

async function applyHandler(payload: unknown) {
  const handler = harness.handlers.get('sidebar-settings:apply-project-order');
  expect(handler).toBeDefined();
  return handler?.({}, payload);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    dataOwnerId: harness.session.dataOwnerId,
    ownerGeneration: harness.session.generation,
    ...extra,
  };
}

describe('projectOrderStore', () => {
  beforeEach(async () => {
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-project-order-'));
    harness.session = { dataOwnerId: 'owner-a', generation: 1 };
    harness.boundaryPending = false;
    harness.handlers.clear();
    harness.send.mockReset();
    harness.untrustedSend.mockReset();
    harness.tapWindowBroadcast.mockReset();
    harness.assertTrusted.mockReset();
    harness.isDeviceLinkInvoke = false;
    vi.resetModules();
    const { registerProjectOrderIpc } = await import('../projectOrderStore');
    registerProjectOrderIpc();
  });

  afterEach(() => {
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it('GET returns a non-authoritative empty snapshot before any write', async () => {
    await expect(getHandler()).resolves.toEqual({
      authoritative: false,
      available: true,
      manualProjectOrder: [],
      projectOrder: 'activity',
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    });
  });

  it('APPLY writes local keys, drops device keys, and broadcasts only to app windows', async () => {
    const snapshot = await applyHandler(stamp({
      projectOrder: 'custom',
      manualProjectOrder: ['local:/repo/a', 'device:other:/repo/b', 'local:/repo/a'],
    }));
    expect(snapshot).toEqual({
      authoritative: true,
      available: true,
      manualProjectOrder: ['local:/repo/a'],
      projectOrder: 'custom',
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    });
    expect(await getHandler()).toEqual(snapshot);
    expect(harness.send).toHaveBeenCalledWith(
      'sidebar-settings:project-order-changed',
      snapshot,
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    );
    expect(harness.tapWindowBroadcast).toHaveBeenCalledWith(
      'sidebar-settings:project-order-changed',
      snapshot,
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    );
    expect(harness.untrustedSend).not.toHaveBeenCalled();
  });

  it('APPLY rejects a missing or mismatched owner stamp', async () => {
    await expect(applyHandler({ projectOrder: 'custom', manualProjectOrder: ['local:/a'] }))
      .rejects.toThrow('[INVALID_PARAMS]');
    await expect(applyHandler(stamp({
      dataOwnerId: 'owner-b',
      projectOrder: 'custom',
      manualProjectOrder: ['local:/a'],
    }))).rejects.toThrow('[PRECONDITION_FAILED]');
    await expect(applyHandler(stamp({
      ownerGeneration: 9,
      projectOrder: 'custom',
      manualProjectOrder: ['local:/a'],
    }))).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.tapWindowBroadcast).not.toHaveBeenCalled();
  });
});
