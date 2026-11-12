#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIPBOARD_MAX_CHARS, parseClipboardContent } from '../../../packages/device-link/src/remoteClipboard.ts';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'cindy-clipboard-native-'));
try {
  const source = join(mobile, 'modules/cindy-remote-presentation/ios/RemoteClipboardSize.swift');
  const fixture = join(mobile, 'scripts/fixtures/remote-clipboard-size.swift');
  const executable = join(directory, 'clipboard-tests');
  execFileSync('swiftc', [source, fixture, '-o', executable], { stdio: 'inherit' });
  const file = join(directory, 'payload.json');
  function check(json, expected) {
    if (expected) assert.doesNotThrow(() => parseClipboardContent(json));
    else assert.throws(() => parseClipboardContent(json), /CLIPBOARD_TOO_LONG/);
    writeFileSync(file, json);
    execFileSync(executable, [file, String(expected)], { stdio: 'inherit' });
  }
  // Same wire payload and boundary decisions in JavaScript and compiled Swift.
  for (const unit of ['a', '中', 'あ', '😀', 'e\u0301']) {
    const length = CLIPBOARD_MAX_CHARS - JSON.stringify({ text: '' }).length;
    const text = unit.repeat(Math.floor(length / unit.length)) + 'x'.repeat(length % unit.length);
    check(JSON.stringify({ text }), true);
    check(JSON.stringify({ text: text + 'x' }), false);
  }
  // Prove this catches the original byte-count guard, not just constant drift.
  const oldSource = join(directory, 'OldClipboardSize.swift');
  writeFileSync(oldSource, readFileSync(source, 'utf8').replace('string.utf16.count', 'string.utf8.count'));
  const oldExecutable = join(directory, 'old-clipboard-tests');
  execFileSync('swiftc', [oldSource, fixture, '-o', oldExecutable]);
  writeFileSync(file, JSON.stringify({ text: '中'.repeat(Math.floor(CLIPBOARD_MAX_CHARS / 2)) }));
  assert.throws(() => execFileSync(oldExecutable, [file, 'true'], { stdio: 'pipe' }));
  console.log('PASS: 10 UTF-16 boundaries agree with shared protocol; old byte guard fails');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
