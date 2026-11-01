#!/usr/bin/env node
/**
 * Test fixture: a tiny Hermes stand-in. Tolerates the full `hermes chat …`
 * flag set (ignores anything it doesn't know) and emits a scripted
 * stream-json session on stdout.
 *
 * Fixture flags (scan-only, values may appear anywhere):
 *   --behavior happy|slow|fail|missing-session   script to run (default happy)
 *   --session-id <id>            session_id reported by system/init
 *   --record <path>              write the full argv as JSON here (assertions)
 *   --fail-when-resumed          exit 5 if --resume is present
 *
 * `FAKE_RECORD_LOG` appends one JSON line of argv per invocation, so a test can
 * inspect every attempt (e.g. the resume that failed and the fresh retry).
 */

import * as fs from 'node:fs';

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const behavior = flagValue('--behavior') ?? process.env.FAKE_BEHAVIOR ?? 'happy';
const sessionId = flagValue('--session-id') ?? 'fake-h-1';
// The installed CLI reports an empty session_id on init and the real id on
// result; FAKE_INIT_EMPTY reproduces that shape.
const initSessionId = process.env.FAKE_INIT_EMPTY ? '' : sessionId;
// The daemon builds argv (not the test), so tests that need to assert argv
// set FAKE_RECORD in the environment instead of passing --record.
const record = flagValue('--record') ?? process.env.FAKE_RECORD;
if (record) fs.writeFileSync(record, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_RECORD_LOG) {
  fs.appendFileSync(process.env.FAKE_RECORD_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
}

// FAKE_RECORD_ENV appends one JSON line per invocation with the HERMES_HOME and the CINDY_PROBE
// session env the daemon gave the child (per-session-home tests assert both).
if (process.env.FAKE_RECORD_ENV) {
  fs.appendFileSync(
    process.env.FAKE_RECORD_ENV,
    JSON.stringify({
      home: process.env.HERMES_HOME ?? null,
      probe: process.env.CINDY_PROBE ?? null,
      argv: process.argv.slice(2),
    }) + '\n',
  );
}

// The real CLI stamps every stream-json event with a ms timestamp
// (see real-hermes-transcript.ndjson).
const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now() }) + '\n');

// `plugins enable|disable <name>`: FAKE_PLUGINS_FAIL makes it fail like a
// missing plugin. The argv is already recorded above (FAKE_RECORD_ENV).
if (process.argv.includes('plugins')) {
  if (process.env.FAKE_PLUGINS_FAIL) {
    process.stderr.write('simulated plugin toggle failure\n');
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes('--version')) {
  if (process.env.FAKE_VERSION_ERROR) {
    process.stderr.write('simulated version failure\n');
    process.exit(1);
  }
  process.stdout.write(`Hermes Agent v${process.env.FAKE_VERSION ?? '0.22.5'} (test fixture)\n`);
  process.exit(0);
}

// FAKE_RECORD_TEXT appends one JSON line {argv, text} per invocation (stdin is
// read to EOF first; the daemon closes it after writing the query).
if (process.env.FAKE_RECORD_TEXT) {
  fs.appendFileSync(
    process.env.FAKE_RECORD_TEXT,
    JSON.stringify({ argv: process.argv.slice(2), text: fs.readFileSync(0, 'utf8') }) + '\n',
  );
}

// Consume stdin (the daemon writes the query then closes it) without parsing.
process.stdin.resume();

if (behavior === 'happy') {
  if (flagValue('--fail-when-resumed') && process.argv.includes('--resume')) process.exit(5);
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
  emit({ type: 'text', text: 'Hello ' });
  emit({ type: 'text', text: 'world' });
  emit({ type: 'tool_use', name: 'terminal', tool_call_id: 't1', input: { cmd: 'ls' } });
  emit({ type: 'tool_result', name: 'terminal', tool_call_id: 't1', output: 'file.txt', duration_ms: 4, is_error: false });
  emit({
    type: 'result',
    session_id: sessionId,
    exit_code: 0,
    text: 'Hello world',
    tokens: { input: 10, output: 5, total: 15, cache_read: 0, cache_write: 0 },
    duration_ms: 42,
  });
  process.exit(0);
} else if (behavior === 'slow') {
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGINT', () => {
    emit({ type: 'result', session_id: sessionId, exit_code: 0, text: 'interrupted cleanly' });
    clearInterval(keepAlive);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    process.exit(9);
  });
} else if (behavior === 'fail') {
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: initSessionId });
  emit({ type: 'text', text: 'partial output then boom' });
  process.stderr.write('simulated hermes crash\n');
  process.exit(3);
} else if (behavior === 'missing-session') {
  // Mirrors the real CLI: `--resume <unknown>` emits init with an empty
  // session_id and a failed result carrying the lookup error, then exits 1.
  const resumeIndex = process.argv.indexOf('--resume');
  const resumeId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
  if (!resumeId) {
    emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: 'fake-h-fresh' });
    emit({ type: 'text', text: 'Fresh start' });
    emit({
      type: 'result',
      session_id: 'fake-h-fresh',
      exit_code: 0,
      text: 'Fresh start',
      tokens: { input: 3, output: 2, total: 5, cache_read: 0, cache_write: 0 },
      duration_ms: 11,
    });
    process.exit(0);
  }
  const error = `No session found matching '${resumeId}'. Use 'hermes sessions list' to see available sessions, or pass -c <name> --create-if-missing to start a new session with that title.`;
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: '' });
  emit({
    type: 'result',
    session_id: '',
    exit_code: 1,
    text: '',
    tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 },
    error,
  });
  process.stderr.write(`Error: ${error}\n\nsession_id:\n`);
  process.exit(1);
} else {
  process.stderr.write(`unknown behavior: ${behavior}\n`);
  process.exit(2);
}
