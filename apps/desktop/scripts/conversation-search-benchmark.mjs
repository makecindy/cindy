#!/usr/bin/env node
/**
 * Explicit, isolated performance experiment; not a default unit test.
 * Run: node apps/desktop/scripts/conversation-search-benchmark.mjs [baseline-ref]
 * Uses real search functions/SQLite/FTS with synthetic data, no account or network.
 * Timings exclude fixture setup and metric serialization. JSON row bytes estimate
 * worker transfer volume; this in-process harness does not measure worker RPC/UI.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const require = createRequire(path.join(desktop, 'package.json'));
const baseline = process.argv[2] ?? 'HEAD';
const baselineSha = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const localDb = path.join(desktop, 'src/main/localDb');
const wideChars = 4096; // Each task has 4 KiB summary + 4 KiB codex plan.
const samples = 5;
const scratch = await mkdtemp(path.join(tmpdir(), 'cindy-search-benchmark-'));

async function loadSearch(version) {
  const outfile = path.join(scratch, `${version}.cjs`);
  await build({
    stdin: {
      contents: `export { searchConversations } from './conversationSearch.ts';
        export { setCurrentDbClient, clearCurrentDbClient } from './client/current.ts';
        export * as schema from './schema.ts';
        export { drizzle } from 'drizzle-orm/better-sqlite3';
        export { getTableConfig } from 'drizzle-orm/sqlite-core';`,
      resolveDir: localDb,
      loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{
      name: 'isolated-search-benchmark',
      setup(bundler) {
        // External runtime packages resolve from this checkout, not the temp dir.
        bundler.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
          if (specifier.startsWith('@cindy/')) return;
          return { path: specifier.startsWith('node:') ? specifier : require.resolve(specifier), external: true };
        });
        bundler.onLoad({ filter: /[\\/]main[\\/]logger\.ts$/ }, () => ({
          contents: 'export const createLogger = () => ({ info() {}, warn() {} });', loader: 'ts',
        }));
        bundler.onLoad({ filter: /[\\/]embedding-host[\\/]index\.ts$/ }, () => ({
          contents: 'export function getEmbeddingService() { throw new Error("No network in benchmark"); }', loader: 'ts',
        }));
        bundler.onLoad({ filter: /[\\/]embedders[\\/]chat-history-embedder\.ts$/ }, () => ({
          contents: 'export const CHAT_EMBED_MODEL_ID = "synthetic"; export const CHAT_VEC_TABLE = "unused"; export const isChatEmbeddingEnabled = () => false;', loader: 'ts',
        }));
        if (version === 'before') {
          bundler.onLoad({ filter: /[\\/]localDb[\\/](conversationSearch|chatHistorySearch)\.ts$/ }, ({ path: filename }) => ({
            contents: execFileSync('git', ['show', `${baselineSha}:${path.relative(root, filename).split(path.sep).join('/')}`], { cwd: root, encoding: 'utf8' }),
            resolveDir: path.dirname(filename), loader: 'ts',
          }));
        }
      },
    }],
  });
  return require(outfile);
}

function createFixture(api, taskCount, concentrated) {
  const db = new Database(':memory:');
  for (const name of ['sessions', 'messages', 'botProfiles', 'botSessionLinks', 'projectAliases']) {
    const config = api.getTableConfig(api.schema[name]);
    db.exec(`CREATE TABLE "${config.name}" (${config.columns.map(col =>
      `"${col.name}" ${col.getSQLType()}${col.primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
  }
  db.exec(`CREATE INDEX search_session_activity ON sessions(updated_at);
    CREATE INDEX search_message_session ON messages(session_id);
    CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, content);`);
  const insertSession = db.prepare(`INSERT INTO sessions
    (id,title,working_dir,project_dir,workspace_kind,status,source,agent_kind,user_send_at,created_at,updated_at,summary,codex_plan_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMessage = db.prepare(`INSERT INTO messages
    (id,client_id,session_id,role,content,created_at) VALUES (?,?,?,?,?,?)`);
  const insertFts = db.prepare('INSERT INTO messages_fts (message_id,content) VALUES (?,?)');
  db.transaction(() => {
    for (let i = 0; i < taskCount; i++) {
      insertSession.run(`s${i}`, i % 113 === 0 ? `needle task ${i}` : `task ${i}`,
        '/synthetic/project', null, 'project', i % 31 === 30 ? 'deleted' : i % 17 === 16 ? 'archived' : 'active',
        'desktop', i % 7 === 6 ? 'pi' : 'cc', i % 2 ? 1_000_000 + i : null,
        1_000_000 + i, 1_000_000 + i, 's'.repeat(wideChars), 'p'.repeat(wideChars));
    }
    db.exec(`INSERT INTO bot_profiles (id,display_name,status,hidden_at) VALUES ('bot','Synthetic hidden companion','active',1);
      INSERT INTO bot_session_links (session_id,bot_id,role) VALUES ('s0','bot','history');
      UPDATE sessions SET source = 'bot', hidden_at = 1 WHERE id = 's0';
      INSERT INTO project_aliases VALUES ('local:/synthetic/project','Synthetic Alias',1);`);
    for (let i = 0; i < 200; i++) {
      const sessionId = concentrated && i < 130 ? 's0' : `s${i}`;
      const content = `needle contentneedle synthetic message ${i}`;
      insertMessage.run(`m${i}`, `c${i}`, sessionId, i % 2 ? 'assistant' : 'user', JSON.stringify(content), 2_000_000 + i);
      insertFts.run(`m${i}`, content);
    }
  })();
  return db;
}

function instrument(db) {
  let metrics = null;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return sql => {
        const prepareStarted = performance.now();
        const statement = target.prepare(sql);
        if (metrics) {
          metrics.prepareMs += performance.now() - prepareStarted;
          if (sql.includes('messages_fts')) metrics.ftsPrepareMs += performance.now() - prepareStarted;
        }
        const proxy = new Proxy(statement, {
          get(stmt, method) {
            const value = Reflect.get(stmt, method);
            if (typeof value !== 'function') return value;
            return (...args) => {
              const started = performance.now();
              const result = value.apply(stmt, args);
              const duration = performance.now() - started;
              if (metrics && (method === 'all' || method === 'get')) {
                metrics.sqlCount++;
                metrics.maxBindings = Math.max(metrics.maxBindings, args.length);
                const bytes = Buffer.byteLength(JSON.stringify(result ?? null));
                metrics.rowJsonBytes += bytes;
                if (sql.includes('left join "bot_session_links"')) metrics.candidateRowJsonBytes += bytes;
                if (sql.includes('messages_fts')) {
                  metrics.ftsQueries++;
                  metrics.ftsSqlMs += duration;
                }
              }
              return result === stmt ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
  return {
    db: wrapped,
    startMetrics() { metrics = { sqlCount: 0, ftsQueries: 0, ftsSqlMs: 0, prepareMs: 0, ftsPrepareMs: 0, maxBindings: 0, rowJsonBytes: 0, candidateRowJsonBytes: 0 }; },
    endMetrics() { const result = metrics; metrics = null; return result; },
  };
}

function connect(api, fixture) {
  const tracked = instrument(fixture);
  api.setCurrentDbClient({
    drizzle: api.drizzle(tracked.db, { schema: api.schema }),
    query: async (sql, params) => tracked.db.prepare(sql).all(...params),
    queryOne: async (sql, params) => tracked.db.prepare(sql).get(...params),
    vecAvailable: false,
  }, 'synthetic-benchmark-owner');
  return tracked;
}

const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
try {
  const before = await loadSearch('before');
  const after = await loadSearch('after');
  const rows = [];
  for (const taskCount of [1000, 10000]) {
    for (const concentrated of [false, true]) {
      const fixture = createFixture(after, taskCount, concentrated);
      try {
        const tracked = { before: connect(before, fixture), after: connect(after, fixture) };
        const request = { query: 'contentneedle', limit: 20, semanticMode: 'keyword' };
        // Compare the full response, including ordering, companion ownership,
        // previews, counts, poolCapped and vector diagnostics on the same data.
        for (const sortBy of ['relevance', 'activityAsc', 'activityDesc']) {
          for (const query of ['contentneedle', 'needle', 'ndl', 'Alias']) {
            const req = { ...request, query, sortBy };
            const scope = { remoteVisibleOnly: query === 'Alias' };
            assert.deepEqual(await after.searchConversations(req, scope), await before.searchConversations(req, scope));
          }
        }
        const timings = { before: [], after: [] };
        // Alternate order to reduce warm-cache / scheduler bias.
        for (let i = 0; i < samples; i++) {
          for (const version of i % 2 ? ['after', 'before'] : ['before', 'after']) {
            const start = performance.now();
            await ({ before, after })[version].searchConversations(request);
            timings[version].push(performance.now() - start);
          }
        }
        const measurements = {};
        for (const [version, api] of Object.entries({ before, after })) {
          tracked[version].startMetrics();
          const result = await api.searchConversations(request);
          measurements[version] = {
            medianFirstResponseMs: Number(median(timings[version]).toFixed(2)),
            samplesMs: timings[version].map(ms => Number(ms.toFixed(2))),
            ...tracked[version].endMetrics(),
            results: result.results.length, poolCapped: result.poolCapped,
          };
        }
        rows.push({ taskCount, concentrated, ...measurements });
      } finally {
        before.clearCurrentDbClient();
        after.clearCurrentDbClient();
        fixture.close();
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ baselineSha, platform: process.platform, arch: process.arch,
    nodeVersion: process.version, taskWideFieldBytes: wideChars * 2, samples, responseComparisons: 48,
    notes: 'Synthetic in-memory SQLite, warmed queries; keyword path; embedding disabled; row JSON bytes are an estimate, not measured worker traffic; no UI or user database measured.', rows }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
