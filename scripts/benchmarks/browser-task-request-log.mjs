/**
 * Timing helpers for running the browser fixture tasks in an app that keeps no local transcript.
 * Opt-in, never part of unit tests. It only sees requests to the local fixture pages and reads no
 * account, credential or conversation. Method and limits: docs/benchmarks/browser-tasks-2026-11-11.
 *
 *   node scripts/benchmarks/browser-task-request-log.mjs proxy <fixture-base> <port> <log>
 *     Forwards http://127.0.0.1:<port> to the fixture server started by
 *     `node --import tsx scripts/eval-browser-tasks.mjs --serve` and appends one JSON line per
 *     request to <log>: {"t": epoch ms, "m": method, "u": path and query}.
 *   node scripts/benchmarks/browser-task-request-log.mjs wait <log> <pattern> [--count 1] [--since <ms>] [--limit 300]
 *     Blocks until <count> requests at or after <since> match <pattern> (a case-insensitive
 *     regular expression tested against "METHOD /path?query"), then prints
 *     {"first", "terminal", "requests", "now"} in epoch ms. Exits 1 after <limit> seconds.
 */
import http from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  count: { type: 'string', default: '1' }, since: { type: 'string', default: '0' }, limit: { type: 'string', default: '300' },
} });
const [mode, ...rest] = positionals;

if (mode === 'proxy' && rest.length === 3) {
  const [target, port, log] = rest;
  const upstream = new URL(target);
  http.createServer((req, res) => {
    appendFileSync(log, `${JSON.stringify({ t: Date.now(), m: req.method, u: req.url })}\n`);
    const out = http.request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    out.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(out);
  }).listen(Number(port), '127.0.0.1', () => console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, target, log })));
} else if (mode === 'wait' && rest.length === 2) {
  const [log, pattern] = rest;
  const matcher = new RegExp(pattern, 'i');
  const count = Number(values.count), since = Number(values.since), deadline = Date.now() + Number(values.limit) * 1000;
  for (;;) {
    const rows = (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((row) => row.t >= since);
    const hits = rows.filter((row) => matcher.test(`${row.m} ${row.u}`));
    if (hits.length >= count) {
      console.log(JSON.stringify({ first: rows[0].t, terminal: hits[count - 1].t, requests: rows.length, now: Date.now() }));
      break;
    }
    if (Date.now() > deadline) { console.log(JSON.stringify({ timeout: true, now: Date.now() })); process.exit(1); }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
} else {
  console.error('Usage:\n  browser-task-request-log.mjs proxy <fixture-base> <port> <log>\n  browser-task-request-log.mjs wait <log> <pattern> [--count 1] [--since <ms>] [--limit 300]');
  process.exit(2);
}
