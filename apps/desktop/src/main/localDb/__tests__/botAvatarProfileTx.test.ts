import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tx as runWorkerTx } from '../worker/opHandlers/tx';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('Bot avatar profile transaction', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        avatar TEXT NOT NULL
      );
      CREATE TABLE media_blobs (hash TEXT PRIMARY KEY);
      CREATE TABLE media_refs (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL REFERENCES media_blobs(hash),
        ref_kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        origin_kind TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO bot_profiles VALUES ('bot-1', 1, 1, '🤖');
      INSERT INTO media_blobs VALUES ('${HASH_A}'), ('${HASH_B}');
      INSERT INTO media_refs VALUES ('old-ref', '${HASH_A}', 'bot-avatar', 'bot-1', 'user', 1);
    `);
  });

  afterEach(() => db.close());

  function update(args: Record<string, unknown>) {
    return runWorkerTx(db, {
      name: 'bots.updateProfile',
      args: {
        id: 'bot-1',
        avatar: `cindy-media://blobs/${HASH_B}.webp`,
        identitySource: '',
        capabilitiesJson: '{}',
        profileContentChanged: false,
        expectedCurrentVersion: 1,
        now: 2,
        ...args,
      },
    });
  }

  it('switches the profile address and exact media ref in one transaction', () => {
    update({ botAvatarRef: { id: 'new-ref', hash: HASH_B, createdAt: 2 } });

    expect(db.prepare('SELECT avatar FROM bot_profiles WHERE id = ?').get('bot-1')).toEqual({
      avatar: `cindy-media://blobs/${HASH_B}.webp`,
    });
    expect(db.prepare('SELECT id, hash FROM media_refs WHERE ref_id = ?').all('bot-1')).toEqual([
      { id: 'new-ref', hash: HASH_B },
    ]);
  });

  it('rolls the profile address back when the new ref cannot be inserted', () => {
    expect(() =>
      update({
        botAvatarRef: { id: 'new-ref', hash: 'c'.repeat(64), createdAt: 2 },
      }),
    ).toThrow();

    expect(db.prepare('SELECT avatar FROM bot_profiles WHERE id = ?').get('bot-1')).toEqual({
      avatar: '🤖',
    });
    expect(db.prepare('SELECT id FROM media_refs WHERE ref_id = ?').all('bot-1')).toEqual([
      { id: 'old-ref' },
    ]);
  });

  it('clears the private image ref when the Bot returns to an emoji', () => {
    update({ avatar: '🚀', clearBotAvatarRefs: true });
    expect(db.prepare('SELECT avatar FROM bot_profiles WHERE id = ?').get('bot-1')).toEqual({
      avatar: '🚀',
    });
    expect(db.prepare('SELECT id FROM media_refs WHERE ref_id = ?').all('bot-1')).toEqual([]);
  });
});
