import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { readLocalWorktreeReferences } from '../worktreeReferences';
import type { DatabaseConstructor } from '../runtime';

const currentColumns = ['id', 'status', 'working_dir', 'worktree_path', 'source', 'remote_host_id'];
const schemaRows = (columns = currentColumns) => columns.map((name) => ({ name }));

describe('machine-local task reference reader', () => {
  let root: string;
  let currentPath: string;
  let current: Database.Database;
  const opened = vi.fn();
  const closed = vi.fn();
  const otherQuery = vi.fn();
  class ReadOnlyDatabase {
    constructor(file: string, options: Database.Options) { opened(file, options); }
    transaction<T>(callback: () => T) { return callback; }
    prepare(sql: string) { return { all: () => otherQuery(sql) }; }
    close() { closed(); }
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-task-reference-test-'));
    currentPath = path.join(root, 'cindy-current.db');
    fs.writeFileSync(currentPath, 'test fixture placeholder');
    current = { transaction: <T>(callback: () => T) => callback, prepare: (sql: string) => ({ all: () => sql === 'PRAGMA database_list'
      ? [{ name: 'main', file: currentPath }]
      : sql === 'PRAGMA table_info(sessions)' ? schemaRows()
      : [{ id: 'current-task', status: 'active', workingDir: root, worktreePath: null, source: 'desktop' }] }) } as unknown as Database.Database;
    opened.mockReset(); closed.mockReset();
    otherQuery.mockReset().mockImplementation((sql: string) => sql === 'PRAGMA table_info(sessions)'
      ? schemaRows()
      : [{ id: 'other-task', status: 'active', workingDir: root, worktreePath: null, source: 'desktop' }]);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const read = () => readLocalWorktreeReferences(current, ReadOnlyDatabase as unknown as DatabaseConstructor, 'test-native-binding');

  it('aggregates current and other local databases through read-only handles without changing owners', () => {
    fs.writeFileSync(path.join(root, 'cindy-other.db'), '');
    fs.writeFileSync(path.join(root, 'xdt-legacy.db'), '');
    fs.writeFileSync(path.join(root, 'unrelated.db'), '');
    const rows = read();
    expect(rows.filter((row) => row.currentDatabase)).toHaveLength(1);
    expect(rows.filter((row) => !row.currentDatabase)).toHaveLength(2);
    expect(opened).toHaveBeenCalledTimes(2);
    for (const [, options] of opened.mock.calls) expect(options).toEqual({ readonly: true, fileMustExist: true, nativeBinding: 'test-native-binding' });
    expect(closed).toHaveBeenCalledTimes(2);
    const queries = otherQuery.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('SELECT'));
    expect(queries).toHaveLength(2);
    for (const sql of queries) {
      expect(sql).toContain('remote_host_id IS NULL');
      expect(sql).not.toContain('messages');
    }
  });
  it('does not return a partial view when another database cannot be queried', () => {
    fs.writeFileSync(path.join(root, 'cindy-other.db'), '');
    otherQuery.mockImplementation(() => { throw new Error('locked database'); });
    expect(read).toThrow('locked database');
    expect(closed).toHaveBeenCalledTimes(1);
  });
  it('rejects unrecognized profile layouts rather than ignoring them', () => {
    fs.mkdirSync(path.join(root, 'profiles'));
    fs.mkdirSync(path.join(root, 'profiles', 'another-profile'));
    expect(read).toThrow('profile database catalog');
  });
  it('rejects a source created during the scan', () => {
    fs.writeFileSync(path.join(root, 'cindy-other.db'), '');
    otherQuery.mockImplementation((sql: string) => {
      if (sql === 'PRAGMA table_info(sessions)') return schemaRows();
      fs.writeFileSync(path.join(root, 'cindy-new.db'), '');
      return [];
    });
    expect(read).toThrow('catalog changed');
  });
  it('rejects a directory masquerading as a database', () => {
    fs.mkdirSync(path.join(root, 'cindy-other.db'));
    expect(read).toThrow('regular file');
  });
});

describe('historical task reference schemas (isolated SQLite)', () => {
  let root: string;
  let current: Database.Database;
  const initialSchema = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, working_dir TEXT)';
  const additions = [
    'ALTER TABLE sessions ADD worktree_path TEXT',
    "ALTER TABLE sessions ADD source TEXT NOT NULL DEFAULT 'desktop'",
    'ALTER TABLE sessions ADD remote_host_id TEXT',
  ];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-legacy-reference-db-'));
    current = new Database(path.join(root, 'cindy-current.db'));
    current.exec([initialSchema, ...additions].join(';'));
  });
  afterEach(() => {
    current?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads pre-0005, pre-0007 and pre-0038 databases without changing them or dropping terminal references', () => {
    const before = new Map<string, Buffer>();
    for (let count = 0; count < additions.length; count += 1) {
      const file = path.join(root, `xdt-legacy-${count}.db`);
      const legacy = new Database(file);
      try {
        legacy.exec([initialSchema, ...additions.slice(0, count)].join(';'));
        legacy.prepare('INSERT INTO sessions (id, status, working_dir) VALUES (?, ?, ?)')
          .run(`legacy-${count}`, 'archived', path.join(root, `working-${count}`));
        if (count > 0) legacy.prepare('UPDATE sessions SET worktree_path = ?').run(path.join(root, `worktree-${count}`));
      } finally { legacy.close(); }
      before.set(file, fs.readFileSync(file));
    }
    current.prepare('INSERT INTO sessions (id, status, working_dir, remote_host_id) VALUES (?, ?, ?, ?)')
      .run('remote', 'active', '/remote/worktree', 'ssh-host');
    current.prepare('INSERT INTO sessions (id, status, working_dir) VALUES (?, ?, ?)')
      .run('local', 'archived', root);

    const rows = readLocalWorktreeReferences(current, Database);
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.id === 'local')).toMatchObject({ status: 'archived', currentDatabase: true });
    for (let count = 0; count < additions.length; count += 1) {
      expect(rows.find((row) => row.id === `legacy-${count}`)).toEqual({
        id: `legacy-${count}`, status: null, currentDatabase: false,
        source: count > 1 ? 'desktop' : null,
        workingDir: path.join(root, `working-${count}`),
        worktreePath: count > 0 ? path.join(root, `worktree-${count}`) : null,
      });
    }
    for (const [file, bytes] of before) expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it.each([
    'CREATE TABLE sessions (id TEXT, status TEXT)',
    `${initialSchema};${additions[1]}`,
    `${initialSchema};${additions[0]};${additions[2]}`,
    'CREATE TABLE unrelated (id TEXT)',
  ])('rejects incomplete or unrecognized schemas instead of ignoring that database: %s', (sql) => {
    const file = path.join(root, 'cindy-unknown.db');
    const legacy = new Database(file);
    try { legacy.exec(sql); } finally { legacy.close(); }
    expect(() => readLocalWorktreeReferences(current, Database)).toThrow('unsupported task reference schema');
  });
});
