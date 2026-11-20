// Unit tier: real settings persistence must preserve other projects and isolate accounts.
// Minimal input: two projects, a reset, then an account switch; no user's profile is opened.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ root: '', owner: 'a' }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  ownerScopedUserDataPath: (file: string) => path.join(h.root, h.owner, file),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
import { readProjectIcons, setProjectIcon } from '../projectIconStore';
beforeAll(() => {
  h.root = mkdtempSync(path.join(os.tmpdir(), 'cindy-project-icons-'));
});
afterAll(() => rmSync(h.root, { recursive: true, force: true }));
it('persists scoped overrides and resets only the selected project', async () => {
  await setProjectIcon('local:/one', '🚀');
  await setProjectIcon('local:/two', '🎨');
  expect(readProjectIcons()).toEqual({ 'local:/one': '🚀', 'local:/two': '🎨' });
  await setProjectIcon('local:/one', null);
  expect(readProjectIcons()).toEqual({ 'local:/two': '🎨' });
  h.owner = 'b';
  expect(readProjectIcons()).toEqual({});
  await setProjectIcon('local:/one', '🌱');
  h.owner = 'a';
  expect(readProjectIcons()).toEqual({ 'local:/two': '🎨' });
});
it('rejects arbitrary content before persisting it', async () => {
  await expect(setProjectIcon('local:/one', 'file:///private/picture')).rejects.toThrow(
    'INVALID_PARAMS',
  );
  expect(readProjectIcons()).toEqual({ 'local:/two': '🎨' });
});

// A colored symbol used to fail validation and disappear on disk readback.
it('persists color-only edits and restores the theme default without changing the shape', async () => {
  await setProjectIcon('local:/color', 'symbol:Rocket:blue');
  expect(readProjectIcons()['local:/color']).toBe('symbol:Rocket:blue');
  await setProjectIcon('local:/color', 'symbol:Rocket:purple');
  expect(readProjectIcons()['local:/color']).toBe('symbol:Rocket:purple');
  await setProjectIcon('local:/color', 'symbol:Rocket:white');
  expect(readProjectIcons()['local:/color']).toBe('symbol:Rocket:white');
  await setProjectIcon('local:/color', 'symbol:Rocket');
  expect(readProjectIcons()['local:/color']).toBe('symbol:Rocket');
  await setProjectIcon('local:/color', null);
  expect(readProjectIcons()['local:/color']).toBeUndefined();
});
