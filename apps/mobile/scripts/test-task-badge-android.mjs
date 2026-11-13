#!/usr/bin/env node
// Native integration tier: compile the production receiver with fake Android storage/launcher.
// Regression: old/foreign/partial background pushes must not replace a complete count.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = process.env.CINDY_BADGE_TEST_KOTLINC;
const jdk = process.env.CINDY_BADGE_TEST_JDK_HOME;
const json = process.env.CINDY_BADGE_TEST_JSON_JAR;
if (!compiler || !jdk || !json) throw new Error('Provide CINDY_BADGE_TEST_KOTLINC, CINDY_BADGE_TEST_JDK_HOME and CINDY_BADGE_TEST_JSON_JAR');
const directory = mkdtempSync(join(tmpdir(), 'cindy-task-badge-test-'));
const started = performance.now();
try {
  const fixtures = join(mobile, 'scripts/fixtures/task-badge-android');
  const jar = join(directory, 'badge.jar');
  execFileSync(compiler, [join(mobile, 'modules/cindy-chat-notifications/android/src/main/java/app/cindy/notifications/TaskBadgeDelivery.kt'),
    ...readdirSync(fixtures).filter(file => file.endsWith('.kt')).map(file => join(fixtures, file)),
    '-cp', json, '-include-runtime', '-d', jar], { env: { ...process.env, JAVA_HOME: jdk }, stdio: 'inherit' });
  execFileSync(join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-cp', jar + delimiter + json, 'app.cindy.notifications.BadgeFixtureKt'], { stdio: 'inherit' });
  console.log(`Native compile and regression: ${((performance.now() - started) / 1000).toFixed(2)}s`);
} finally { rmSync(directory, { recursive: true, force: true }); }
