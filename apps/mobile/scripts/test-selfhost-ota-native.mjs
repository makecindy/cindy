#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { patchSources } = require('../plugins/selfhost-ota/patches');
const expo = dirname(require.resolve('expo-updates/package.json'));
const directory = mkdtempSync(join(tmpdir(), 'cindy-native-ota-test-'));
try {
  const executable = join(directory, 'journal-tests');
  execFileSync('swiftc', [
    join(mobile, 'plugins/selfhost-ota/ios/CindyOtaJournal.swift'),
    join(mobile, 'scripts/fixtures/selfhost-ota-journal.swift'), '-o', executable,
  ], { stdio: 'inherit' });
  execFileSync(executable, [directory], { stdio: 'inherit' });
  for (const [file, source] of patchSources((file) => readFileSync(join(expo, file), 'utf8'))) {
    if (!file.endsWith('.swift')) continue;
    const temporarySource = join(directory, file.split('/').pop());
    writeFileSync(temporarySource, source);
    execFileSync('swiftc', ['-parse', temporarySource], { stdio: 'inherit' });
  }
  console.log('PASS: all adapted Expo Swift sources parse');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
