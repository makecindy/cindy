#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = process.env.CINDY_OTA_TEST_KOTLINC;
const jdk = process.env.CINDY_OTA_TEST_JDK_HOME;
const json = process.env.CINDY_OTA_TEST_JSON_JAR;
if (!compiler || !jdk || !json) throw new Error('Provide CINDY_OTA_TEST_KOTLINC, CINDY_OTA_TEST_JDK_HOME and CINDY_OTA_TEST_JSON_JAR');
const directory = mkdtempSync(join(tmpdir(), 'cindy-android-ota-test-'));
try {
  const fixtures = join(mobile, 'scripts/fixtures/selfhost-ota-android');
  const jar = join(directory, 'journal.jar');
  execFileSync(compiler, [
    join(mobile, 'plugins/selfhost-ota/android/CindyOtaJournal.kt'),
    ...readdirSync(fixtures).filter((file) => file.endsWith('.kt')).map((file) => join(fixtures, file)),
    '-cp', json, '-include-runtime', '-d', jar,
  ], { env: { ...process.env, JAVA_HOME: jdk }, stdio: 'inherit' });
  execFileSync(join(jdk, 'bin/java'), ['-cp', jar + delimiter + json, 'expo.modules.updates.JournalFixtureKt', directory], { stdio: 'inherit' });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
