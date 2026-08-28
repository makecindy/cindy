import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ permissionFile: '' }));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: () => testState.permissionFile,
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const {
  readGhostToolPermissions,
  resolveToolApprovalMode,
  writeGhostToolPermissions,
} = await import('../ghostToolPermissionsStore.js');

let tempDir = '';

describe('Ghost tool-permission unreadable file handling', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-tool-permissions-'));
    testState.permissionFile = path.join(tempDir, 'ghost-tool-permissions.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    testState.permissionFile = '';
  });

  it('keeps the unreadable file and denies enforcement until it is repaired', () => {
    const malformed = '{"permissions":{"art":{"globalPolicy":"blocked"}}';
    fs.writeFileSync(testState.permissionFile, malformed, 'utf8');

    // Renderer reads may still receive the safe display fallback, but enforcement
    // must not reinterpret an unavailable policy file as an empty policy.
    expect(readGhostToolPermissions('art')).toEqual({});
    expect(() => resolveToolApprovalMode('art', 'run')).toThrow(/unreadable/);
    expect(fs.readFileSync(testState.permissionFile, 'utf8')).toBe(malformed);

    fs.writeFileSync(
      testState.permissionFile,
      JSON.stringify({ permissions: { art: { tools: { run: 'blocked' } } } }),
      'utf8',
    );
    const repairedAt = new Date(Date.now() + 5_000);
    fs.utimesSync(testState.permissionFile, repairedAt, repairedAt);

    expect(resolveToolApprovalMode('art', 'run')).toBe('blocked');
  });

  it('refuses permission mutations while the existing file is unreadable', () => {
    const malformed = '{"permissions":';
    fs.writeFileSync(testState.permissionFile, malformed, 'utf8');

    expect(() => writeGhostToolPermissions('art', { globalPolicy: 'always-allow' })).toThrow(
      /unreadable/,
    );
    expect(fs.readFileSync(testState.permissionFile, 'utf8')).toBe(malformed);
  });
});
