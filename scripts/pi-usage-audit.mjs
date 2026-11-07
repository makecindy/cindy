#!/usr/bin/env node
// Read-only reconciliation. A model/day difference is not authorization to backfill.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Match Desktop normalizeModelIdForPricing after removing the ledger-only
// billing marker. Keep raw model IDs in the source identity fingerprint below.
function auditModelKey(raw) {
  const model = typeof raw === 'string' ? raw.trim().replace(/#billing=subscription$/, '') : '';
  return model.replace(/\[[^\]]*\]\s*$/, '').trim() || 'unknown';
}

export function auditPiUsageEntries(entries, ledgerRows, since = '') {
  const seen = new Map();
  const totals = new Map();
  const diagnostics = { missingIdentity: 0, invalidUsage: 0, conflictingIdentity: 0, duplicates: 0 };
  for (const entry of entries) {
    const message = entry?.message;
    if (message?.role !== 'assistant' || !message.usage) continue;
    const identity = message.id ?? entry.id;
    const timestamp = new Date(message.timestamp ?? entry.timestamp);
    const values = ['input', 'output', 'cacheRead', 'cacheWrite'].map(key => message.usage[key] ?? 0);
    if (!Number.isFinite(timestamp.getTime()) || values.some(v => !Number.isSafeInteger(v) || v < 0)) {
      diagnostics.invalidUsage++;
      continue;
    }
    if (typeof identity !== 'string' || !identity) { diagnostics.missingIdentity++; continue; }
    const model = typeof message.model === 'string' ? message.model : 'unknown';
    const fingerprint = JSON.stringify([timestamp.getTime(), model, values]);
    if (seen.has(identity)) {
      if (seen.get(identity) !== fingerprint) diagnostics.conflictingIdentity++;
      else diagnostics.duplicates++;
      continue;
    }
    seen.set(identity, fingerprint);
    const day = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')}`;
    if (day < since) continue;
    const key = JSON.stringify([day, auditModelKey(model)]);
    totals.set(key, (totals.get(key) ?? 0) + values.reduce((a, b) => a + b, 0));
  }
  const ledger = new Map();
  for (const row of ledgerRows) {
    if (row.day < since || row.agent_kind !== 'pi') continue;
    const model = auditModelKey(row.model);
    const key = JSON.stringify([row.day, model]);
    ledger.set(key, (ledger.get(key) ?? 0) + ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_create_tokens']
      .reduce((sum, k) => sum + (row[k] ?? 0), 0));
  }
  return {
    readOnly: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, diagnostics,
    rows: [...new Set([...totals.keys(), ...ledger.keys()])].sort().map(key => {
      const [day, model] = JSON.parse(key);
      return { day, model, transcriptTokens: totals.get(key) ?? 0, ledgerTokens: ledger.get(key) ?? 0,
        difference: (totals.get(key) ?? 0) - (ledger.get(key) ?? 0) };
    }),
    limitations: ['Differences include unsettled turns, day-boundary attribution and missing/deleted transcripts.',
      'Historical aggregates do not identify which requests were booked. Do not automatically backfill these differences.'],
  };
}

async function* readEntries(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, file.name);
    if (file.isDirectory()) yield* readEntries(filename);
    else if (file.isFile() && file.name.endsWith('.jsonl')) {
      const input = createReadStream(filename, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          yield JSON.parse(line);
        }
      } finally { lines.close(); input.destroy(); }
    }
  }
}

export async function runPiUsageAudit(directory, database, since = '') {
  // Explicit paths only; never discover or mutate the user's active profile.
  const entries = [];
  for await (const entry of readEntries(directory)) {
    if (entry?.message?.role === 'assistant' && entry.message.usage) {
      const { id, timestamp, model, usage } = entry.message;
      entries.push({ id: entry.id, timestamp: entry.timestamp, message: { role: 'assistant', id, timestamp, model, usage } });
    }
  }
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT day, agent_kind, model, input_tokens, output_tokens, cache_read_tokens,
      cache_create_tokens FROM daily_model_usage WHERE agent_kind = 'pi' AND day >= ?`).all(since);
    return auditPiUsageEntries(entries, rows, since);
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, database, since = ''] = process.argv.slice(2);
  if (!directory || !database || (since && !/^\d{4}-\d{2}-\d{2}$/.test(since))) {
    process.stderr.write('Usage: node scripts/pi-usage-audit.mjs <sessions-dir> <database> [YYYY-MM-DD]\n');
    process.exitCode = 1;
  } else {
    try { process.stdout.write(`${JSON.stringify(await runPiUsageAudit(directory, database, since), null, 2)}\n`); }
    catch { process.stderr.write('Pi usage audit failed: verify paths, read access and JSONL completeness. No ledger writes were attempted.\n'); process.exitCode = 1; }
  }
}
