import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piDisabledDiscoveryPaths } from '../skill-activation.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-alias-')); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function link(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function deepTree(): string {
  const deepest = path.join(root, ...Array<string>(32).fill('d'));
  fs.mkdirSync(deepest, { recursive: true });
  return deepest;
}

describe('bounded Pi disabled Skill alias discovery', () => {
  it('keeps native paths and resolves ordinary nested imports without following cycles', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
    const discovery = path.join(root, 'skills');
    const alias = path.join(discovery, 'nested', 'alias');
    link(source, alias);
    link(discovery, path.join(discovery, 'cycle'));
    expect(piDisabledDiscoveryPaths([source], [discovery])).toEqual([source, alias]);
    const scan = vi.spyOn(fs, 'opendirSync');
    expect(piDisabledDiscoveryPaths([], [discovery])).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(['entries', 'time'])('resolves direct aliases before an unrelated subtree exhausts %s', (budget) => {
    const discovery = path.join(root, 'skills');
    const large = path.join(discovery, 'a-large');
    const source = path.join(root, 'source');
    const alias = path.join(discovery, 'z-alias');
    const secondRoot = path.join(root, 'other-skills');
    const secondAlias = path.join(secondRoot, 'alias');
    fs.mkdirSync(large, { recursive: true });
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
    link(source, alias);
    link(source, secondAlias);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const open = fs.opendirSync.bind(fs);
    let largeReads = 0;
    const closed = vi.fn();
    vi.spyOn(fs, 'opendirSync').mockImplementation((entry, options) => {
      if (entry === discovery) {
        // Force the pathological ordering independently of filesystem order.
        const entries = fs.readdirSync(entry, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        return { readSync: () => entries.shift() ?? null, closeSync: vi.fn() } as unknown as fs.Dir;
      }
      if (entry === large) {
        // A directory stream with arbitrarily many irrelevant entries.
        return {
          readSync: () => {
            largeReads += 1;
            if (budget === 'time') elapsed = 101;
            return { name: '.ignored' };
          },
          closeSync: closed,
        } as unknown as fs.Dir;
      }
      return open(entry, options);
    });
    expect(piDisabledDiscoveryPaths([source], [discovery, secondRoot])).toEqual([source, alias, secondAlias]);
    expect(largeReads).toBeGreaterThan(0);
    expect(largeReads).toBeLessThanOrEqual(2048);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('caps traversal through a linked deep directory while retaining the disabled source', () => {
    const deepest = deepTree();
    const alias = path.join(root, 'alias');
    link(path.join(root, 'd'), alias);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const stat = vi.spyOn(fs, 'statSync');
    expect(piDisabledDiscoveryPaths([deepest], [alias])).toEqual([deepest]);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(17);
  });

  it('caps enumeration in a wide directory instead of inspecting every file', () => {
    // Exercise a wide directory without creating thousands of files on Windows.
    // Real paths, junctions and directory streams are covered by the other cases.
    let reads = 0;
    const close = vi.fn();
    vi.spyOn(fs, 'opendirSync').mockReturnValue({
      readSync: () => reads < 2200 ? { name: `f${reads++}` } : null,
      closeSync: close,
    } as unknown as fs.Dir);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((entry) => String(entry));
    const directoryStat = fs.statSync(root);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const stat = vi.spyOn(fs, 'statSync').mockImplementation((entry) => ({
      ...directoryStat, isDirectory: () => String(entry) === root,
    }));
    const disabled = path.join(root, 'absent-skill');
    expect(piDisabledDiscoveryPaths([disabled], [root])).toEqual([disabled]);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(2048);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(2048);
    expect(close).toHaveBeenCalledOnce();
  });

  it('stops further filesystem visits when the time budget expires', () => {
    const deepest = deepTree();
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { elapsed += 25; return elapsed; });
    const stat = vi.spyOn(fs, 'statSync');
    expect(piDisabledDiscoveryPaths([deepest], [root])).toEqual([deepest]);
    expect(stat.mock.calls.length).toBeLessThan(3);
  });
});
