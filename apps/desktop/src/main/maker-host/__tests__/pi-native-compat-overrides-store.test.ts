import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const root = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => root.path } }));
vi.mock('../logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } }));
import { readPiNativeCompatOverride as read, recordPiNativeCompatOverride as record } from '../pi-native-compat-overrides-store.js';
root.path = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-compat-'));
const file = path.join(root.path, 'pi-native-compat-overrides.json');
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const fix = { supportsLongCacheRetention: false };
afterAll(() => fs.rmSync(root.path, { recursive: true, force: true }));
beforeEach(() => { fs.rmSync(file, { force: true }); });
describe('learned cache compatibility', () => {
  it('persists only the permitted fix and isolates connection, wire model and route', async () => {
    expect(await record('a', 'model', { ...fix, supportsStore: true }, a)).toBe(true);
    expect(read('a', 'model', a)).toEqual(fix);
    expect(read('b', 'model', a)).toBeUndefined();
    expect(read('a', 'other', a)).toBeUndefined();
    expect(read('a', 'model', b)).toBeUndefined();
    expect(read('a', 'model')).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('supportsStore');
  });
  it('merges concurrent updates without losing another model', async () => {
    expect(await Promise.all([record('a', 'one', fix, a), record('a', 'two', fix, a)])).toEqual([true, true]);
    expect(read('a', 'one', a)).toEqual(fix);
    expect(read('a', 'two', a)).toEqual(fix);
  });
  it('does not overwrite malformed files or report an unpersisted success', async () => {
    fs.writeFileSync(file, '{bad-json');
    expect(await record('a', 'model', fix, a)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad-json');
  });
  it('does not import unscoped legacy records into a new route', () => {
    fs.writeFileSync(file, JSON.stringify({ models: { a: { model: fix } } }));
    expect(read('a', 'model', a)).toBeUndefined();
  });
  it('allows precise reset by removing an entry and observes file replacement', async () => {
    await record('a', 'model', fix, a);
    const replacement = file + '.replacement';
    fs.writeFileSync(replacement, JSON.stringify({ routes: {} }));
    fs.renameSync(replacement, file);
    expect(read('a', 'model', a)).toBeUndefined();
  });
  it('rejects missing routes, controls and arbitrary compat patches', async () => {
    expect(await record('a', 'model', fix)).toBe(false);
    expect(await record('a', 'model\n', fix, a)).toBe(false);
    expect(await record('a', 'model', { supportsStore: false }, a)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});
