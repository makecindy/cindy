import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginDesktopDevInstance,
  markDesktopDevReady,
  markDesktopDevStartupFailed,
  markDesktopDevWindowReady,
  recordDesktopDevAuthStartupResult,
  recordDesktopDevLocalDbStartupResult,
} from '../devStartupStatus.js';

describe('devStartupStatus', () => {
  let tempDir: string;
  let statusPath: string;
  let cleanup: (() => void) | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dev-status-'));
    statusPath = path.join(tempDir, 'startup.json');
    process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = statusPath;
    cleanup = null;
  });

  afterEach(() => {
    cleanup?.();
    delete process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks startup ready only after both the window and application are ready', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: path.join(tempDir, 'repo'),
      commit: 'abc123',
      mode: 'remote',
      region: 'cn',
      passive: true,
      isolated: false,
      pid: 4242,
      instanceId: 'test-owner',
      startedAtMs: 100,
    });

    markDesktopDevWindowReady();

    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'window-ready',
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(tempDir, '.dev-instances', '4242.json'),
      'utf8',
    ))).toMatchObject({ state: 'starting' });

    markDesktopDevReady();

    const external = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const persistent = JSON.parse(fs.readFileSync(
      path.join(tempDir, '.dev-instances', '4242.json'),
      'utf8',
    ));
    expect(external).toMatchObject({ state: 'ready', instance: { commit: 'abc123' } });
    expect(persistent).toMatchObject({
      state: 'ready',
      rootDir: path.join(tempDir, 'repo'),
      mode: 'remote',
      region: 'cn',
      passive: true,
    });
  });

  it('supports application readiness arriving before ready-to-show', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4245,
    });

    markDesktopDevReady();
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({ state: 'pending' });

    markDesktopDevWindowReady();
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({ state: 'ready' });
  });

  it('keeps restart pending when logged-out is only the auth timeout fallback', async () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4248,
    });
    markDesktopDevWindowReady();

    let settleAuth!: (state: { isAuthenticated: boolean; user: unknown | null }) => void;
    const pendingAuth = new Promise<{ isAuthenticated: boolean; user: unknown | null }>((resolve) => {
      settleAuth = resolve;
    });
    recordDesktopDevAuthStartupResult(
      { isAuthenticated: false, user: null },
      pendingAuth,
      () => ({ isAuthenticated: false, user: null }),
    );
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'window-ready',
    });

    settleAuth({ isAuthenticated: false, user: null });
    await pendingAuth;
    await Promise.resolve();
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({ state: 'ready' });
  });

  it('waits for localDb when manual login supersedes the timed-out refresh', async () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4249,
    });
    markDesktopDevWindowReady();

    // The stale background flow resolves as logged out after authStateEpoch changes,
    // while authManager's live state already contains the manually logged-in user.
    const pendingAuth = Promise.resolve({ isAuthenticated: false, user: null });
    recordDesktopDevAuthStartupResult(
      { isAuthenticated: false, user: null },
      pendingAuth,
      () => ({ isAuthenticated: true, user: { id: 'manual-user' } }),
    );
    await pendingAuth;
    await Promise.resolve();
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'window-ready',
    });

    recordDesktopDevLocalDbStartupResult({
      ready: false,
      error: { code: 'MIGRATE_FAILED', message: 'late migration failure' },
    });
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'failed',
      code: 'MIGRATE_FAILED',
    });
  });

  it('preserves a concrete main-process failure for the restart waiter', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      mode: 'remote',
      passive: true,
      isolated: false,
      pid: 4243,
    });

    markDesktopDevStartupFailed(
      'SINGLE_INSTANCE_OWNED',
      'Another Cindy instance owns the primary slot.',
      { userDataDir: '/tmp/Cindy' },
    );

    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'failed',
      code: 'SINGLE_INSTANCE_OWNED',
      detail: { userDataDir: '/tmp/Cindy' },
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(tempDir, '.dev-instances', '4243.json'),
      'utf8',
    ))).toMatchObject({
      state: 'failed',
      failure: { code: 'SINGLE_INSTANCE_OWNED' },
    });
  });

  it('forwards the localDb migration code and message to the restart waiter', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4247,
    });

    markDesktopDevWindowReady();
    recordDesktopDevLocalDbStartupResult({
      ready: false,
      error: {
        code: 'MIGRATE_FAILED',
        message: 'applied migration runtime identity changed at seq 77 (0077_nebulous_veda.sql)',
      },
    });

    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'failed',
      code: 'MIGRATE_FAILED',
      message: expect.stringContaining('seq 77 (0077_nebulous_veda.sql)'),
      detail: { phase: 'local-db:ensure-ready' },
    });
  });

  it('does not replace a completed startup with a later runtime failure', () => {
    fs.writeFileSync(statusPath, '{"state":"pending"}\n');
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4246,
    });

    markDesktopDevWindowReady();
    markDesktopDevReady();
    markDesktopDevStartupFailed('MIGRATE_FAILED', 'late failure');

    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({ state: 'ready' });
    expect(JSON.parse(fs.readFileSync(
      path.join(tempDir, '.dev-instances', '4246.json'),
      'utf8',
    ))).toMatchObject({ state: 'ready' });
  });

  it('cleanup never deletes a record that has been replaced by another owner', () => {
    cleanup = beginDesktopDevInstance({
      userDataDir: tempDir,
      rootDir: tempDir,
      passive: false,
      isolated: false,
      pid: 4244,
      instanceId: 'first-owner',
    });
    const instancePath = path.join(tempDir, '.dev-instances', '4244.json');
    fs.writeFileSync(instancePath, '{"instanceId":"replacement"}\n');

    cleanup();
    cleanup = null;

    expect(fs.existsSync(instancePath)).toBe(true);
  });
});
