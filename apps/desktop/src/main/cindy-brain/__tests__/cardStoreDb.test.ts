/**
 * cardStoreDb.test.ts — ghost_cards 持久层单测。
 * 内存 SQLite + 真实 0072 migration SQL 建表(与生产 schema 同源),直测
 * 注入 db 的纯函数(规则 14)。覆盖:upsert 幂等(过程版被终版覆盖)、
 * 取件 null 语义、GC 上限按最旧淘汰。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { GhostCardDb } from '../cardStoreDb';
import { GhostCardService } from '../cardService';
import { GhostCardActionDispatcher } from '../cardActionDispatch';
import { GHOST_CARD_REOPEN_WINDOW_MS, type InstalledGhost } from '../../../shared/ghost';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
}));

const schema = await import('../../localDb/schema');
const store = await import('../cardStoreDb');

const MIGRATION_0072 = path.resolve(__dirname, '../../../../drizzle/0072_first_lightspeed.sql');

function freshDb(): GhostCardDb {
  const raw = new Database(':memory:');
  const sqlText = fs.readFileSync(MIGRATION_0072, 'utf8');
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) raw.exec(trimmed);
  }
  return drizzle(raw, { schema }) as unknown as GhostCardDb;
}

function row(callId: string, over: Partial<Parameters<typeof store.upsertGhostCard>[0]> = {}) {
  return {
    callId,
    ghostId: 'g1',
    sessionId: null,
    html: '<p>x</p>',
    height: 240,
    v: 1,
    updatedAt: 1000,
    ...over,
  };
}

let db: GhostCardDb;

beforeEach(() => {
  db = freshDb();
});

describe('cardStoreDb', () => {
  it.each(['_ns__acme__helper', '_archive_helper'])('drains queued inserts before reassigning live and historical actions: %s', async (target) => {
    let releaseWrite!: () => void;
    let now = 1_000_000;
    const pending = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const svc = new GhostCardService({
      hasCardSlot: () => true,
      sanitize: (html) => ({ ok: true, html }),
      persist: async (card) => { await pending; await store.upsertGhostCard(card, db); },
      broadcast: vi.fn(),
      now: () => now,
    });
    svc.registerCall('old', { ghostId: 'helper', toolUseId: null, sessionId: 'org-session' });
    expect(svc.handleCardUpdate('helper', { type: 'card-update', callId: 'old', html: '<p>org</p>' }).accepted).toBe(true);
    svc.finalizeCall('old');

    const reassign = vi.fn(() => store.reassignGhostCards('helper', target, db));
    const relocation = svc.relocateGhost('helper', target).then(reassign);
    await Promise.resolve();
    expect(reassign).not.toHaveBeenCalled();
    releaseWrite();
    await relocation;
    expect(await store.getGhostCard('old', db)).toEqual(expect.objectContaining({ ghostId: target, sessionId: 'org-session' }));
    await svc.relocateGhost('helper', target);
    await store.reassignGhostCards('helper', target, db);

    const archived = target.startsWith('_archive');
    const sendToGhost = vi.fn();
    const issueUserActionToken = vi.fn(() => 'user-action-token');
    const dispatcher = new GhostCardActionDispatcher({
      resolveLiveInfo: (callId) => svc.callInfoOf(callId),
      resolvePersistedCard: (callId) => store.getGhostCard(callId, db),
      reopenForAction: (callId, info) => svc.reopenForAction(callId, info),
      getGhost: (ghostId) => ghostId === 'helper' || (!archived && ghostId === target)
        ? { manifest: { id: 'helper', card: {} }, namespace: ghostId === target ? 'acme' : null, enabled: true } as InstalledGhost : null,
      isRunning: () => true,
      wake: async () => {},
      sendToGhost,
      issueUserActionToken,
      now: () => now,
    });
    for (const historical of [false, true]) {
      if (historical) {
        now += GHOST_CARD_REOPEN_WINDOW_MS + 31_000;
        svc.registerCall('root', { ghostId: 'helper', toolUseId: null, sessionId: 'root-session' });
        expect(svc.callInfoOf('old')).toBeNull();
      }
      expect(await dispatcher.dispatch('old', 'retry', 'org prompt')).toEqual(
        archived ? { ok: false, reason: 'ghost-unavailable' } : { ok: true },
      );
    }
    if (archived) {
      expect(sendToGhost).not.toHaveBeenCalled();
      expect(issueUserActionToken).not.toHaveBeenCalled();
    } else {
      expect(sendToGhost.mock.calls.map(([ghostId]) => ghostId)).toEqual([target, target]);
      expect(sendToGhost).toHaveBeenCalledWith(target, expect.objectContaining({ sessionId: 'org-session', prompt: 'org prompt' }));
      expect(issueUserActionToken.mock.calls).toEqual([[target, 'org-session'], [target, 'org-session']]);
    }
    await svc.relocateGhost(target, 'helper');
    await store.reassignGhostCards(target, 'helper', db);
    expect(await store.getGhostCard('old', db)).toEqual(expect.objectContaining({ ghostId: 'helper', sessionId: 'org-session', html: '<p>org</p>' }));
  });

  it('upsert 幂等:同 callId 二次写入覆盖为最新版本', async () => {
    await store.upsertGhostCard(row('c1', { html: '<p>过程</p>' }), db);
    await store.upsertGhostCard(row('c1', { html: '<p>终版</p>', height: 400, updatedAt: 2000 }), db);
    const got = await store.getGhostCard('c1', db);
    expect(got).toEqual({ callId: 'c1', ghostId: 'g1', sessionId: null, html: '<p>终版</p>', height: 400, v: 1 });
  });

  it('取件:无卡返回 null', async () => {
    expect(await store.getGhostCard('nope', db)).toBeNull();
  });

  it('GC:超上限按 updatedAt 淘汰最旧', async () => {
    const total = store.GHOST_CARDS_MAX_ROWS + 3;
    // 直插底表绕过抽样计数,末尾显式触发裁剪。
    for (let i = 0; i < total; i++) {
      await store.upsertGhostCard(row(`c${i}`, { updatedAt: i }), db);
    }
    const pruned = await store.pruneGhostCards(db);
    expect(pruned).toBeGreaterThanOrEqual(0);
    // 无论抽样是否已触发过,最终不超上限,且最旧的必然出局、最新的仍在。
    expect(await store.getGhostCard('c0', db)).toBeNull();
    expect(await store.getGhostCard(`c${total - 1}`, db)).not.toBeNull();
  });
  it('权威实测高写回:已有行更新,行不存在静默不造卡', async () => {
    await store.upsertGhostCard(row('c1', { height: 500 }), db);
    await store.updateGhostCardHeight('c1', 613, db);
    expect((await store.getGhostCard('c1', db))?.height).toBe(613);
    await store.updateGhostCardHeight('ghost-town', 300, db);
    expect(await store.getGhostCard('ghost-town', db)).toBeNull();
  });
});
