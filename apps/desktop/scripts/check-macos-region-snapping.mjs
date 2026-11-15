#!/usr/bin/env node
// Explicit native E2E: node apps/desktop/scripts/check-macos-region-snapping.mjs
// Production entry: macos-snapshot.swift's JSON protocol against owned AppKit
// windows. #7661 added window-at without initializing NSApplication, returning
// 0 even over a real window. Unit tests mock native replies and cannot catch it.
// Minimal failure: a fresh helper + window-at at the visible window's center.
// --helper=<binary> runs the same assertions against a pre-fix shipping helper.
// Requires a logged-in Mac desktop; AX region checks also require Accessibility.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin', 'Requires an interactive macOS desktop');
const desktop = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-macos-snapping-'));
const started = performance.now();
const clients = [];
function client(binary) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let sequence = 0;
  const fail = (error) => {
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', () => fail(new Error('Native process exited')));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const reply = JSON.parse(line);
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    } catch (error) { fail(error); }
  });
  const ask = (payload) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native timeout: ${payload.op}`));
    }, 5000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
  });
  clients.push(child);
  return ask;
}
async function eventually(operation, predicate, label) {
  const deadline = Date.now() + 3000;
  let result;
  do {
    result = await operation();
    if (predicate(result)) return result;
    // E2E: allow WindowServer composition / AX exposure to catch up.
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(result)}`);
}
try {
  const fixtureBinary = path.join(temp, 'windows');
  execFileSync('swiftc', [path.join(desktop, 'scripts/fixtures/region-capture/macos-windows.swift'), '-O', '-o', fixtureBinary]);
  let binary = process.argv.find(arg => arg.startsWith('--helper='))?.slice(9);
  if (!binary) {
    binary = path.join(temp, 'snapshot');
    execFileSync('swiftc', [path.join(desktop, 'native/region-screenshot/macos-snapshot.swift'), '-O', '-o', binary]);
  }
  const fixture = client(fixtureBinary);
  const geometry = await fixture({ op: 'state' });
  const [left, top, right, bottom] = geometry.rect;
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const helper = client(binary);
  const windows = (await helper({ op: 'windows' })).windows;
  assert.ok(windows.some(w => w.hwnd === geometry.hwnd), 'Fixture is in production window snapshot');
  const hit = (p = point, exclude = []) => helper({ op: 'window-at', ...p, exclude });
  await eventually(() => hit(), r => r.hwnd === geometry.hwnd, 'Cold helper must hit a real window');
  const after = await fixture({ op: 'state' });
  assert.equal(after.frontmost, geometry.frontmost, 'Helper startup must not activate an application');
  assert.deepEqual(after.pointer, geometry.pointer, 'Helper must not move the system pointer');

  const content = await eventually(() => helper({ op: 'elements', pid: geometry.pid,
    hwnd: geometry.hwnd, rect: geometry.rect, ...point }), r => r.preferredRect?.every((v, i) =>
    Math.abs(v - geometry.content[i]) <= 2), 'AX must select the scroll content region (requires Accessibility)');
  assert.ok(content.rects.length > 1, 'Fine element chain remains available');
  const toolbar = await helper({ op: 'elements', pid: geometry.pid, hwnd: geometry.hwnd,
    rect: geometry.rect, x: point.x, y: top + 10 });
  assert.deepEqual(toolbar.preferredRect, geometry.rect, 'Title bar selects the whole window');

  const overlay = await fixture({ op: 'overlay' });
  const opaque = { x: right - 80, y: point.y };
  const transparent = { x: left + 80, y: point.y };
  await eventually(() => hit(opaque), r => r.hwnd === overlay.overlay, 'Opaque front window must occlude the target');
  await eventually(() => hit(opaque, [overlay.overlay]), r => r.hwnd === geometry.hwnd, 'Exclude only the screenshot overlay');
  const coveredContent = await helper({ op: 'elements', pid: geometry.pid, hwnd: geometry.hwnd,
    rect: geometry.rect, ...point });
  assert.deepEqual(coveredContent.preferredRect, content.preferredRect, 'Content region remains identifiable underneath the screenshot overlay');
  await fixture({ op: 'overlay', ignore: true });
  await eventually(() => hit(opaque), r => r.hwnd === geometry.hwnd, 'Input-ignoring overlay must not intercept snapping');
  // Re-enable input: a real occluder must block again, including on systems
  // whose hit-testing treats visually transparent pixels as input regions.
  await fixture({ op: 'overlay', ignore: false });
  await eventually(() => hit(opaque), r => r.hwnd === overlay.overlay, 'Re-enabled opaque region must block again');
  const reference = await fixture({ op: 'state' });
  assert.ok([geometry.hwnd, overlay.overlay].includes(reference.transparentHit), 'Reference hit belongs to an owned window');
  assert.equal((await hit(transparent)).hwnd, reference.transparentHit, 'Transparent pixel follows native AppKit hit testing');
  await fixture({ op: 'hide' });
  // A second fresh process catches accidental reliance on a previous session.
  const second = client(binary);
  assert.equal((await second({ op: 'window-at', ...point, exclude: [] })).hwnd, geometry.hwnd);
  console.log(JSON.stringify({ result: 'passed', seconds: +((performance.now() - started) / 1000).toFixed(2),
    checks: ['cold-start', 'focus', 'pointer', 'content-region', 'title-bar', 'opaque-occluder',
      'exclude-overlay', 'covered-content-region', 'native-transparent-hit', 'ignores-mouse-events', 'second-session'] }));
} finally {
  for (const child of clients.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.stdin.end();
    try { await exited; } finally { clearTimeout(timer); }
  }
  await rm(temp, { recursive: true, force: true });
}
