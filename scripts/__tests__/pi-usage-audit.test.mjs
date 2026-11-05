import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditPiUsageEntries, runPiUsageAudit } from '../pi-usage-audit.mjs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// #8887: read-only audit must not count forked transcript copies as new spend.
describe('Pi usage audit', () => {
  const entry = (id, input = 100) => ({ id, timestamp: '2026-11-05T12:00:00+08:00',
    message: { role: 'assistant', model: 'm', usage: { input, output: 20, cacheRead: 30, cacheWrite: 4 } } });
  it('deduplicates forked entry IDs without dropping separate requests', () => {
    const result = auditPiUsageEntries([entry('a'), entry('a'), entry('b')], []);
    assert.equal(result.rows[0].transcriptTokens, 308);
    assert.equal(result.diagnostics.duplicates, 1);
    assert.equal(result.readOnly, true);
  });
  it('reports unknown identities and inconsistent duplicates instead of guessing', () => {
    const result = auditPiUsageEntries([entry('a'), entry('a', 500), entry(undefined), entry('bad', NaN)], []);
    assert.deepEqual(result.diagnostics, { missingIdentity: 1, invalidUsage: 1, conflictingIdentity: 1, duplicates: 0 });
    assert.equal(result.rows[0].transcriptTokens, 154);
  });
  it('compares subscription rows without counting another harness and preserves negative differences', () => {
    const day = auditPiUsageEntries([entry('a')], []).rows[0].day;
    const result = auditPiUsageEntries([entry('a')], [
      { day, agent_kind: 'pi', model: 'm#billing=subscription', input_tokens: 200 },
      { day, agent_kind: 'codex', model: 'm', input_tokens: 999 },
    ]);
    assert.equal(result.rows[0].difference, -46);
    assert.equal(auditPiUsageEntries([entry('a')], [], '2027-01-01').rows.length, 0);
  });
  it('compares native context suffixes using the same model key as the ledger', () => {
    const request = entry('context');
    request.message.model = ' gpt-5.6-sol[1m] ';
    const day = auditPiUsageEntries([request], []).rows[0].day;
    const result = auditPiUsageEntries([request], [
      { day, agent_kind: 'pi', model: 'gpt-5.6-sol#billing=subscription', input_tokens: 154 },
    ]);
    assert.deepEqual(result.rows, [{ day, model: 'gpt-5.6-sol', transcriptTokens: 154, ledgerTokens: 154, difference: 0 }]);
    // Normalizing aggregation keys must not conceal conflicting source identities.
    const conflicting = { ...request, message: { ...request.message, model: 'gpt-5.6-sol' } };
    assert.equal(auditPiUsageEntries([request, conflicting], []).diagnostics.conflictingIdentity, 1);
  });
  it('reads real JSONL and SQLite without rewriting either or exposing message content', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-audit-'));
    try {
      const transcripts = path.join(directory, 'sessions');
      await mkdir(transcripts);
      const file = path.join(transcripts, 'task.jsonl');
      const entries = [entry('paid'), entry('paid')];
      entries[0].message.content = [{ type: 'text', text: 'private message' }];
      await writeFile(file, entries.map(e => JSON.stringify(e)).join('\n'));
      const database = path.join(directory, 'ledger.db');
      const db = new Database(database);
      db.exec(`CREATE TABLE daily_model_usage(day TEXT, agent_kind TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER)`);
      db.close();
      const before = await readFile(database);
      const transcriptBefore = await readFile(file);
      const result = await runPiUsageAudit(transcripts, database);
      assert.equal(result.rows[0].difference, 154);
      assert.equal(result.diagnostics.duplicates, 1);
      assert.equal(JSON.stringify(result).includes('private message'), false);
      assert.deepEqual(await readFile(database), before);
      assert.deepEqual(await readFile(file), transcriptBefore);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
