// macOS native integration: compiles the production Network listener, drives real TCP/HTTP,
// and deletes every fixture/process. Does not require an installed mobile app or account.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

if (process.platform !== 'darwin') throw new Error('This test requires Apple Network.framework on macOS');
const dir = await mkdtemp(join(tmpdir(), 'cindy-html-native-test-'));
let child;
try {
  await writeFile(join(dir, '0'), '<!doctype html><meta charset="utf-8"><h1>中文</h1>');
  await writeFile(join(dir, '1'), 'body { color: green; }');
  await writeFile(join(dir, '2'), '<h1>Second page</h1>');
  await writeFile(join(dir, 'main.swift'), `import Foundation
import Network
let queue = DispatchQueue(label: "test")
let server = try HtmlSnapshotServer(root: CommandLine.arguments[1], entry: "index.html", token: String(repeating: "a", count: 48), csp: "default-src 'none'; style-src 'self'", files: [["index.html", "0", "text/html"], ["dist/main.css", "1", "text/css"], ["second.html", "2", "text/html"]], queue: queue)
server.start { result in
  switch result {
    case .success(let url): print(url); fflush(stdout)
    case .failure(let error): print(error); exit(1)
  }
}
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: queue)
termination.setEventHandler { server.stop(); exit(0) }
termination.resume()
dispatchMain()
`);
  execFileSync('xcrun', ['swiftc', fileURLToPath(new URL('../modules/cindy-html-preview/ios/HtmlSnapshotServer.swift', import.meta.url)), join(dir, 'main.swift'), '-o', join(dir, 'server')], { timeout: 60_000 });
  child = spawn(join(dir, 'server'), [dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native listener did not start')), 10_000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Listener exited ${code}`)); });
    child.stdout.once('data', (data) => { clearTimeout(timer); resolve(data.toString().trim()); });
  });
  const initial = new URL(url);
  const origin = initial.origin;
  const bootstrap = await fetch(url, { redirect: 'manual' });
  assert.equal(bootstrap.status, 302);
  assert.equal(bootstrap.headers.get('location'), '/index.html');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(origin + '/index.html')).status, 403);
  const page = await fetch(origin + '/index.html', { headers: { cookie } });
  assert.match(await page.text(), /中文/);
  assert.match(page.headers.get('content-type'), /charset=utf-8/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const css = await fetch(origin + '/dist/main.css', { headers: { cookie } });
  assert.equal(css.headers.get('content-type'), 'text/css');
  assert.match(await css.text(), /green/);
  assert.equal((await fetch(origin + '/second.html', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(origin + '/', { headers: { cookie } })).status, 200);
  const head = await fetch(origin + '/index.html', { method: 'HEAD', headers: { cookie } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal((await fetch(origin + '/0', { headers: { cookie } })).status, 404);
  assert.equal((await fetch(origin + '/index.html', { headers: { cookie, Origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(origin + '/index.html', { method: 'POST', headers: { cookie } })).status, 400);
  const raw = (parts) => new Promise((resolve, reject) => {
    const client = net.connect(Number(initial.port), '127.0.0.1');
    let response = '';
    client.setTimeout(3000, () => client.destroy(new Error('TCP timeout')));
    client.on('error', reject);
    client.on('data', (chunk) => { response += chunk.toString(); });
    client.on('end', () => resolve(response));
    client.once('connect', () => { client.write(parts[0]); setTimeout(() => client.write(parts.slice(1).join('')), 20); });
  });
  assert.match(await raw(['GET /index.html HTTP/1.1\r\nHo', `st: ${initial.host}\r\nCookie: ${cookie}\r\n\r\n`]), /^HTTP\/1.1 200/);
  assert.match(await raw([`GET /index.html HTTP/1.1\r\nHost: ${initial.host}\r\n`, `Host: evil\r\nCookie: ${cookie}\r\n\r\n`]), /^HTTP\/1.1 400/);
  assert.match(await raw([`GET /%2e%2e/index.html HTTP/1.1\r\nHost: ${initial.host}\r\n`, `Cookie: ${cookie}\r\n\r\n`]), /^HTTP\/1.1 403/);
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
  await assert.rejects(fetch(origin + '/index.html', { headers: { cookie } }));
  console.log('PASS: native loopback listener, bootstrap/cookie, HTML/CSS/navigation, HEAD, manifest isolation, foreign origin, malformed/split headers, traversal and shutdown');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
