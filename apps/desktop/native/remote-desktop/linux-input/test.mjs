import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Explicit native integration check: requires build dependencies, never connects
// to the compositor or injects input. Unit tests cover the main-process adapter.
test('native input rejects invalid batches before applying any event', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-input-test-'));
  try {
    const build = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./build.mjs', import.meta.url)), output],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(build.status, 0, build.stderr);
    const run = (input) =>
      spawnSync(path.join(output, 'cindy-linux-desktop-input'), ['--validate'], {
        input,
        encoding: 'utf8',
        timeout: 8000,
      });
    const codes = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
      .map((c) => 'Key' + c)
      .concat(
        [...'0123456789'].map((c) => 'Digit' + c),
        Array.from({ length: 12 }, (_, i) => 'F' + (i + 1)),
        [
          'Enter',
          'Escape',
          'Tab',
          'Space',
          'Backspace',
          'Delete',
          'Insert',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'ShiftLeft',
          'ControlLeft',
          'AltLeft',
          'MetaLeft',
          'Minus',
          'Equal',
          'BracketLeft',
          'BracketRight',
          'Backslash',
          'Semicolon',
          'Quote',
          'Backquote',
          'Comma',
          'Period',
          'Slash',
        ],
      );
    const accepted = run(
      JSON.stringify([
        ...codes.map((code) => ({ kind: 'key', code, down: true })),
        { kind: 'move', x: 0.25, y: 0.75 },
        { kind: 'button', button: 2, down: true, x: 0, y: 1 },
        { kind: 'scroll', dx: -2000, dy: 2000 },
        { kind: 'text', text: '中文🙂\n' },
        { kind: 'release' },
      ]) + '\n[]\n',
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, 'ready\nok\nok\n');
    for (const events of [
      [{ kind: 'move', x: -1, y: 0 }],
      [{ kind: 'key', code: 'Unknown', down: true }],
      [{ kind: 'key', code: 'KeyA', down: 'true' }],
      [{ kind: 'button', button: 1.5, down: true, x: 0, y: 0 }],
      [{ kind: 'scroll', dx: 0, dy: 2001 }],
      [{ kind: 'text', text: 'x'.repeat(4097) }],
      [{ kind: 'text', text: 'embedded\0null' }],
      Array(257).fill({ kind: 'release' }),
    ]) {
      const result = run(JSON.stringify([{ kind: 'release' }, ...events]) + '\n');
      assert.equal(result.status, 2);
      assert.equal(result.stdout, 'ready\n');
    }
    for (const input of [
      '[] trailing\n',
      '[',
      'x'.repeat(32768),
      Buffer.from([91, 34, 255, 34, 93, 10]),
    ]) {
      const result = run(input);
      assert.notEqual(result.stdout, 'ready\nok\n');
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
