#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const outDir = mkdtempSync(join(tmpdir(), 'xdt-mobile-web-smoke-'));
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

try {
  const result = spawnSync(
    pnpmBin,
    ['exec', 'expo', 'export', '--platform', 'web', '--output-dir', outDir],
    {
      cwd: mobileRoot,
      env: {
        ...process.env,
        CI: '1',
        EXPO_NO_TELEMETRY: '1',
      },
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  assertFile('index.html');
  assertFile('metadata.json');
  const bundles = listFiles(join(outDir, '_expo', 'static', 'js', 'web'))
    .filter((file) => file.endsWith('.js'));
  if (bundles.length === 0) {
    throw new Error('Expo web smoke failed: no web JS bundle was emitted');
  }

  const bundleText = bundles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const routeMarkers = [
    'devices.screen',
    'deviceDetail.screen',
    'session.screen',
    'newSession.actions',
    'newSession.createButton',
    'settings.screen',
    'settings.logoutButton',
    'maker:schedule:delete',
  ];
  for (const marker of routeMarkers) {
    if (!bundleText.includes(marker)) {
      throw new Error(`Expo web smoke failed: bundle is missing route marker "${marker}"`);
    }
  }

  console.log(`expo-web-smoke passed: ${bundles.length} bundle(s), ${routeMarkers.length} route markers`);
} finally {
  if (!process.env.XDT_KEEP_MOBILE_WEB_SMOKE_OUTPUT) {
    rmSync(outDir, { recursive: true, force: true });
  } else {
    console.log(`expo-web-smoke output kept at ${outDir}`);
  }
}

function assertFile(relativePath) {
  const fullPath = join(outDir, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Expo web smoke failed: missing ${relativePath}`);
  }
}

function listFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}
