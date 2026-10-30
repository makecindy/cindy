import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../schema';
import type { DbClient } from '../../client/DbClient';
import { tx } from '../../worker/opHandlers/tx';
import { resolveSafe } from '../../../cindy-media/blobStore';
import { migrateLegacyTeammateAvatar } from '../legacyTeammateAvatar';

const state = vi.hoisted(() => ({ userData: '', appPath: '', packaged: false }));
vi.mock('electron', () => ({ app: {
  getPath: () => state.userData,
  getAppPath: () => state.appPath,
  get isPackaged() { return state.packaged; },
} }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
const desktop = path.resolve(__dirname, '../../../../..');

describe('retired teammate avatar migration', () => {
  let raw: Database.Database;
  let client: Pick<DbClient, 'drizzle' | 'tx'>;
  const snapshot = (avatar = 'cindy://avatar/preset/dash') => ({ id: 'old', avatar, currentVersion: 4, updatedAt: 123 });
  const read = () => raw.prepare('SELECT avatar, current_version, updated_at FROM bot_profiles').get() as { avatar: string; current_version: number; updated_at: number };
  beforeEach(() => {
    state.userData = mkdtempSync(path.join(tmpdir(), 'teammate-avatar-migration-'));
    state.appPath = desktop;
    state.packaged = false;
    raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(readFileSync(path.join(desktop, 'drizzle/0070_woozy_harpoon.sql'), 'utf8'));
    raw.exec(`CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, display_name TEXT, avatar TEXT, current_version INTEGER, updated_at INTEGER);
      INSERT INTO bot_profiles VALUES ('old', 'User renamed Dash', 'cindy://avatar/preset/dash', 4, 123);`);
    client = {
      drizzle: drizzle(raw, { schema }),
      tx: (async (name: string, args: unknown) => tx(raw, { name, args })) as DbClient['tx'],
    };
  });
  afterEach(() => { raw.close(); rmSync(state.userData, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it.each(['dash', 'lizi'])('preserves exact %s bytes as a custom image, pins them and is idempotent', async name => {
    const original = snapshot(`cindy://avatar/preset/${name}`);
    raw.prepare('UPDATE bot_profiles SET avatar = ?').run(original.avatar);
    await migrateLegacyTeammateAvatar(client, original, () => {});
    const bytes = readFileSync(path.join(desktop, `resources/legacy-teammate-avatars/${name}.png`));
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(read()).toEqual({ avatar: `cindy-media://blobs/${hash}.png`, current_version: 4, updated_at: 123 });
    const resolved = resolveSafe(read().avatar);
    expect(resolved).not.toBeNull();
    expect(readFileSync(resolved!.absPath)).toEqual(bytes);
    expect(raw.prepare('SELECT hash, ref_kind, ref_id FROM media_refs').all()).toEqual([{ hash, ref_kind: 'bot-avatar', ref_id: 'old' }]);
    expect(await migrateLegacyTeammateAvatar(client, { ...original, avatar: read().avatar }, () => {})).toBe(false);
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
  });

  it.each(['cindy://avatar/preset/cindy', '🌸', `cindy-media://blobs/${'a'.repeat(64)}.png`, 'cindy://avatar/preset/unknown'])('leaves non-legacy address %s untouched', async avatar => {
    const store = vi.spyOn(client, 'tx');
    expect(await migrateLegacyTeammateAvatar(client, snapshot(avatar), () => {})).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT * FROM media_refs').all()).toEqual([]);
  });

  it('keeps the legacy address after a storage failure and retries successfully', async () => {
    state.appPath = state.userData;
    await migrateLegacyTeammateAvatar(client, snapshot(), () => {});
    expect(read().avatar).toBe(snapshot().avatar);
    expect(raw.prepare('SELECT * FROM media_refs').all()).toEqual([]);
    state.appPath = desktop;
    await migrateLegacyTeammateAvatar(client, snapshot(), () => {});
    expect(read().avatar).toMatch(/^cindy-media:/);
  });

  it('loads compatibility bytes from packaged resources rather than the source checkout', async () => {
    const prior = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: path.join(desktop, 'resources') });
    state.packaged = true;
    state.appPath = state.userData;
    try {
      await migrateLegacyTeammateAvatar(client, snapshot(), () => {});
      expect(read().avatar).toMatch(/^cindy-media:/);
    } finally {
      if (prior) Object.defineProperty(process, 'resourcesPath', prior);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('does not replace a concurrent custom avatar at the same profile version', async () => {
    const originalTx = client.tx;
    client.tx = (async (name: string, args: unknown) => {
      raw.prepare('UPDATE bot_profiles SET avatar = ?').run('🌸');
      return originalTx(name as 'bots.updateProfile', args as never);
    }) as DbClient['tx'];
    await migrateLegacyTeammateAvatar(client, snapshot(), () => {});
    expect(read().avatar).toBe('🌸');
    expect(raw.prepare('SELECT * FROM media_refs').all()).toEqual([]);
  });

  it('preserves activity that advances while the old image is being imported', async () => {
    const originalTx = client.tx;
    client.tx = (async (name: string, args: unknown) => {
      raw.prepare('UPDATE bot_profiles SET updated_at = 999').run();
      return originalTx(name as 'bots.updateProfile', args as never);
    }) as DbClient['tx'];
    await migrateLegacyTeammateAvatar(client, snapshot(), () => {});
    expect(read().avatar).toMatch(/^cindy-media:/);
    expect(read().updated_at).toBe(999);
  });

  it('does not publish to a different owner if the account changes during file reading', async () => {
    let checks = 0;
    await expect(migrateLegacyTeammateAvatar(client, snapshot(), () => {
      if (++checks > 1) throw new Error('owner changed');
    })).rejects.toThrow('owner changed');
    expect(read().avatar).toBe(snapshot().avatar);
    expect(raw.prepare('SELECT * FROM media_blobs').all()).toEqual([]);
  });
});
