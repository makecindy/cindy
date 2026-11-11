import { describe, expect, it } from 'vitest';
import type { FileEvidence } from '../../worktree/recoveryArchiveIO';
import { selectPortableEntries } from '../portableEntries';

const dir: FileEvidence = { kind: 'directory', mode: 0o755, hash: '' };
const file: FileEvidence = { kind: 'file', mode: 0o644, hash: 'a'.repeat(64) };
const link = (target: string): FileEvidence => ({ kind: 'link', mode: 0o777, hash: target });
const select = (files: Record<string, FileEvidence>, unsupported: string[] = []) =>
  selectPortableEntries(files, unsupported, '/');

describe('selectPortableEntries', () => {
  it('keeps framework-style link chains and links into a missing build output', () => {
    // The CocoaPods layout that used to block a copy outright.
    const files = {
      Fw: dir,
      'Fw/Versions': dir,
      'Fw/Versions/A': dir,
      'Fw/Versions/A/Headers': dir,
      'Fw/Versions/A/Headers/x.h': file,
      'Fw/Versions/Current': link('A'),
      'Fw/Headers': link('Versions/Current/Headers'),
      Pods: dir,
      'Pods/gen.h': link('../build/generated/gen.h'),
    };
    expect(select(files)).toEqual({ files, skipped: [] });
  });

  it('refuses only links whose resolution leaves the root or reaches .git', () => {
    const { files, skipped } = select({
      a: dir,
      'a/up': link('..'),
      'a/escape': link('up/../outside'),
      'a/chain': link('escape'),
      'a/hop': link('../a/up'),
      'a/via-hop': link('hop/x'),
      'a/inside': link('up/a'),
      'a/absolute': link('/etc/passwd'),
      'a/drive': link('C:/x'),
      'a/git': link('../.git/config'),
      'a/loop': link('loop2'),
      'a/loop2': link('loop'),
    });
    // Chains that stay inside are kept, including one that only dangles at the end.
    expect(Object.keys(files)).toEqual(['a', 'a/up', 'a/hop', 'a/via-hop', 'a/inside']);
    expect(skipped).toEqual(
      ['a/escape', 'a/chain', 'a/absolute', 'a/drive', 'a/git', 'a/loop', 'a/loop2'].map(
        (path) => ({ path, code: 'MIGRATION_EXTERNAL_LINK' }),
      ),
    );
  });

  it('reports a skipped directory once and leaves its subtree behind', () => {
    const { files, skipped } = select(
      {
        'bad ': dir,
        'bad /inner': file,
        'bad /deeper': dir,
        'bad /deeper/x': file,
        Readme: file,
        README: file,
        'into-bad': link('bad /inner'),
      },
      ['dev.sock'],
    );
    expect(Object.keys(files)).toEqual(['Readme', 'into-bad']);
    expect(skipped).toEqual([
      { path: 'dev.sock', code: 'MIGRATION_UNSUPPORTED_ENTRY' },
      { path: 'bad ', code: 'MIGRATION_NONPORTABLE_PATH' },
      { path: 'README', code: 'MIGRATION_PATH_COLLISION' },
    ]);
  });

  it('decides parents first, so a skipped folder never costs the kept one its files', () => {
    const { files, skipped } = select(
      { foo: dir, Foo: dir, 'Foo/x': file, 'foo/x': file, 'Foo/up': link('../..') },
      ['Foo/pipe'],
    );
    expect(Object.keys(files)).toEqual(['foo', 'foo/x']);
    expect(skipped).toEqual([{ path: 'Foo', code: 'MIGRATION_PATH_COLLISION' }]);
  });

  it('treats a link into a skipped folder as dangling, not external', () => {
    const { files, skipped } = select({
      'bad ': dir,
      'bad /up': link('../..'),
      via: link('bad /up/x'),
    });
    expect(Object.keys(files)).toEqual(['via']);
    expect(skipped).toEqual([{ path: 'bad ', code: 'MIGRATION_NONPORTABLE_PATH' }]);
  });

  it('resolves links case-insensitively, as a folding target filesystem would', () => {
    const { files, skipped } = select({ a: dir, 'a/up': link('../..'), sneaky: link('A/UP/x') });
    expect(Object.keys(files)).toEqual(['a']);
    expect(skipped.map((entry) => entry.path)).toEqual(['a/up', 'sneaky']);
  });

  it('accepts platform separators and returns the original keys', () => {
    const { files, skipped } = selectPortableEntries(
      { a: dir, 'a\\b': file, 'a\\c': link('b') },
      ['a\\pipe'],
      '\\',
    );
    expect(Object.keys(files)).toEqual(['a', 'a\\b', 'a\\c']);
    expect(skipped).toEqual([{ path: 'a/pipe', code: 'MIGRATION_UNSUPPORTED_ENTRY' }]);
  });

  it('still treats a malformed manifest as corruption', () => {
    expect(() => select({ x: { kind: 'file', mode: 0o644, hash: 'nope' } })).toThrow(
      'MIGRATION_INVALID_MANIFEST',
    );
    expect(() => select({ 'missing/child': file })).toThrow('MIGRATION_INVALID_MANIFEST');
    expect(() => select({ l: link('.'), 'l/child': file })).toThrow('MIGRATION_INVALID_MANIFEST');
  });
});
