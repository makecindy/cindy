import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Test value (explicit integration tier, never included in default unit tests):
// Production entry: build.mjs + native executable, observed through a real X
// client, not protocol ACKs alone. Protects the X11 input contract requested in
// this task: selected-root coordinates, XTEST edges, delayed ASCII decoding,
// unmappable Unicode rejection, immutable keymaps and runtime physical names,
// ownership-aware EOF/SIGTERM release, atomic batch rejection and capability probe.
// Existing test.mjs exercises only --validate and cannot observe these effects.
// Minimal failures: move(1,1) within a non-root rectangle; text("中文"); a valid
// motion followed by an invalid key. Separate file because this needs isolated
// Xvfb, XTEST and an independently compiled event receiver, not merely Wayland
// build dependencies. Also covers PR #6775 discussion_r4398875925: whole-paste
// checks must preserve held modifiers and reject unsupported suffixes before input.
// Ubuntu 26.04/Nix: 0.97 s including compilation, 4.01 s including Xvfb startup.
// Run: xvfb-run -a node --test apps/desktop/native/remote-desktop/linux-input/x11-test.mjs
const source = path.dirname(fileURLToPath(import.meta.url));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  });
  assert.ifError(result.error);
  return result;
}
function success(command, args, options) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test(
  'real X11 input, current-keymap text and capability rejection',
  { timeout: 60000 },
  async () => {
    assert.equal(process.platform, 'linux', 'Explicit integration requires Linux');
    assert.ok(process.env.DISPLAY, 'Run this file under xvfb-run -a');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-x11-input-test-'));
    let noXtest;
    try {
      success(process.execPath, [path.join(source, 'build.mjs'), output, 'x11']);
      const binary = path.join(output, 'cindy-linux-x11-desktop-input');
      const observer = path.join(output, 'x11-observer');
      const flags = success('pkg-config', ['--cflags', '--libs', 'x11', 'xtst'])
        .trim()
        .split(/\s+/);
      success('cc', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        path.join(source, 'x11-test-client.c'),
        ...flags,
        '-o',
        observer,
      ]);
      success(observer, [binary]);

      const offline = { ...process.env, DISPLAY: ':65534' };
      assert.equal(run(binary, ['--check'], { env: offline }).status, 2);
      const valid = run(binary, ['--validate'], {
        env: offline,
        input: '[{"kind":"text","text":"中文🙂"}]\n',
      });
      assert.equal(valid.status, 0, valid.stderr);
      assert.equal(valid.stdout, 'ready\nok\n');
      for (const geometry of [
        ['-1', '0', '1', '1'],
        ['0', '0', '0', '1'],
        ['0', '0', '1.5', '1'],
        ['0', '0', '32768', '1'],
        ['1000', '0', '1000', '1'],
        ['0', '0', '1'],
      ]) {
        const rejected = run(binary, ['--geometry', ...geometry], { input: '' });
        assert.equal(rejected.status, 2);
        assert.equal(rejected.stdout, '');
      }

      // Dynamic display allocation avoids collisions across worktrees. This second
      // server is necessary: the outer xvfb-run server has XTEST enabled.
      noXtest = spawn(
        'Xvfb',
        [
          '-displayfd',
          '3',
          '-screen',
          '0',
          '1024x768x24',
          '-nolisten',
          'tcp',
          '-extension',
          'XTEST',
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      noXtest.stderr.setEncoding('utf8').on('data', (data) => {
        stderr += data;
      });
      const closed = once(noXtest, 'exit');
      const displayNumber = await new Promise((resolve, reject) => {
        let text = '';
        noXtest.once('error', reject);
        noXtest.once('exit', (code) => reject(new Error(`Xvfb exited ${code}: ${stderr}`)));
        noXtest.stdio[3].setEncoding('utf8').on('data', (data) => {
          text += data;
          if (text.includes('\n')) resolve(text.trim());
        });
      });
      try {
        assert.match(displayNumber, /^\d+$/);
        const rejected = run(binary, ['--check'], {
          env: { ...process.env, DISPLAY: ':' + displayNumber },
        });
        assert.equal(rejected.status, 2, rejected.stderr);
        assert.equal(rejected.stdout, '');
      } finally {
        noXtest.kill('SIGTERM');
        await closed;
        noXtest = undefined;
      }
    } finally {
      noXtest?.kill('SIGTERM');
      fs.rmSync(output, { recursive: true, force: true });
    }
  },
);
