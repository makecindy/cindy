#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { javaRuntimeDetail, resolveJavaRuntimeEnv } from './java-runtime-env.mjs';
import { resolveMobileE2eProfile } from './mobile-e2e-profile.mjs';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const defaultAppId = 'com.xd.cindy';

loadEnvFile(resolve(mobileRoot, '.env'));

const options = parseArgs(process.argv.slice(2));
const profile = resolveMobileE2eProfile(options.profile ?? process.env.XDT_MOBILE_E2E_PROFILE);
const platform = options.platform ?? process.env.XDT_MOBILE_E2E_PLATFORM ?? profile?.platform ?? 'auto';
const appId = options.appId ?? process.env.XDT_MOBILE_E2E_APP_ID ?? profile?.appId ?? defaultAppId;
const expoUrl = options.expoUrl ?? process.env.XDT_MOBILE_E2E_EXPO_URL ?? profile?.expoUrl;
const apiBase = normalizeBaseUrl(
  options.apiBase ?? process.env.XDT_MOBILE_E2E_API_BASE_URL ?? process.env.EXPO_PUBLIC_XDT_API_BASE_URL,
);
const appConfiguredApiBase = normalizeBaseUrl(process.env.EXPO_PUBLIC_XDT_API_BASE_URL);
const toolEnv = resolveJavaRuntimeEnv(process.env);

validatePlatform(platform);

if (options.dryRun) {
  console.log([
    'native-e2e-doctor dry run',
    `- profile: ${profile?.name ?? '<none>'}`,
    `- platform: ${platform}`,
    `- app id: ${appId}`,
    `- expo url: ${expoUrl ?? '<none>'}`,
    `- api base: ${apiBase ?? '<none>'}`,
    `- java: ${javaRuntimeDetail(toolEnv)}`,
    `- require maestro: ${options.requireMaestro ? 'yes' : 'no'}`,
  ].join('\n'));
  process.exit(0);
}

const checks = [];
const maestro = checkMaestro();
const ios = checkIosSimulator();
const android = checkAndroidDevice();
const expo = checkExpoCli();

addCheck({
  label: 'Expo CLI',
  ok: expo.ok,
  detail: expo.detail,
  fix: 'Run pnpm install at the repo root if Expo cannot be resolved through the mobile package.',
  required: true,
});

addCheck({
  label: 'Maestro CLI',
  ok: maestro.ok,
  detail: maestro.detail,
  fix: 'Install Maestro with: curl -Ls "https://get.maestro.mobile.dev" | bash',
  required: options.requireMaestro,
});

addPlatformChecks({ ios, android, platform });

if (appId === 'host.exp.Exponent' && platform === 'android') {
  addCheck({
    label: 'Expo Go Android app id',
    ok: false,
    required: false,
    detail: 'APP_ID is host.exp.Exponent, which is the iOS Expo Go bundle id. Android Expo Go is usually host.exp.exponent.',
    fix: 'Pass --app-id host.exp.exponent when running Maestro against Android Expo Go.',
  });
}

if (appId === 'host.exp.exponent' && platform === 'ios') {
  addCheck({
    label: 'Expo Go iOS app id',
    ok: false,
    required: false,
    detail: 'APP_ID is host.exp.exponent, which is the Android Expo Go package id. iOS Expo Go is host.exp.Exponent.',
    fix: 'Use --profile ios-iphone-17-pro-expo-go, or pass --app-id host.exp.Exponent.',
  });
}

if (appId === 'host.exp.Exponent' && !expoUrl) {
  addCheck({
    label: 'Expo Go launch URL',
    ok: false,
    required: false,
    detail: 'Expo Go runs need an exp:// URL so the runner can open the correct route before Maestro starts.',
    fix: 'Set XDT_MOBILE_E2E_EXPO_URL, or pass --expo-url exp://localhost:8081/--/devices.',
  });
}

if (apiBase && appConfiguredApiBase && apiBase !== appConfiguredApiBase) {
  addCheck({
    label: 'API base consistency',
    ok: false,
    required: false,
    detail: `Runner API base is ${apiBase}, but EXPO_PUBLIC_XDT_API_BASE_URL is ${appConfiguredApiBase}.`,
    fix: 'Start Expo with the same EXPO_PUBLIC_XDT_API_BASE_URL used by the local smoke runner.',
  });
}

printChecks(checks);

const hasFailure = checks.some((check) => check.required && !check.ok);
process.exit(hasFailure ? 1 : 0);

function addPlatformChecks({ ios, android, platform }) {
  if (platform === 'ios' || platform === 'all') {
    addCheck({
      label: 'iOS booted simulator',
      ok: ios.ok,
      detail: ios.detail,
      fix: 'Open Simulator.app or run xcrun simctl boot <device> before the native E2E.',
      required: true,
    });
  }

  if (platform === 'android' || platform === 'all') {
    addCheck({
      label: 'Android connected emulator/device',
      ok: android.ok,
      detail: android.detail,
      fix: 'Start an Android Emulator and confirm adb devices lists one device.',
      required: true,
    });
  }

  if (platform === 'auto') {
    addCheck({
      label: 'Native target device',
      ok: ios.ok || android.ok,
      detail: [
        ios.ok ? `iOS: ${ios.detail}` : null,
        android.ok ? `Android: ${android.detail}` : null,
        !ios.ok && !android.ok ? 'No booted iOS simulator or connected Android device found.' : null,
      ].filter(Boolean).join(' | '),
      fix: 'Boot an iOS Simulator or start an Android Emulator before running Maestro.',
      required: true,
    });
  }
}

function checkMaestro() {
  const result = spawnSync('maestro', ['--version'], { encoding: 'utf8', env: toolEnv });
  if (result.error) return { ok: false, detail: 'maestro command not found' };
  if (result.status !== 0) {
    return { ok: false, detail: result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}` };
  }
  return { ok: true, detail: `${result.stdout.trim() || result.stderr.trim() || 'installed'} (${javaRuntimeDetail(toolEnv)})` };
}

function checkExpoCli() {
  const result = spawnSync(pnpmBin(), ['--filter', 'mobile', 'exec', 'expo', '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) return { ok: false, detail: `${pnpmBin()} command not found` };
  if (result.status !== 0) {
    return { ok: false, detail: result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}` };
  }
  return { ok: true, detail: result.stdout.trim() || result.stderr.trim() || 'installed' };
}

function checkIosSimulator() {
  if (process.platform !== 'darwin') return { ok: false, detail: 'iOS Simulator is only available on macOS' };
  const xcrun = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], { encoding: 'utf8' });
  if (xcrun.error) return { ok: false, detail: 'xcrun command not found' };
  if (xcrun.status !== 0) {
    return { ok: false, detail: xcrun.stderr?.trim() || xcrun.stdout?.trim() || `exit ${xcrun.status}` };
  }
  const booted = xcrun.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('(Booted)'));
  if (booted.length === 0) return { ok: false, detail: 'no booted iOS simulator' };
  return { ok: true, detail: booted.join('; ') };
}

function checkAndroidDevice() {
  const adb = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (adb.error) return { ok: false, detail: 'adb command not found' };
  if (adb.status !== 0) return { ok: false, detail: adb.stderr?.trim() || adb.stdout?.trim() || `exit ${adb.status}` };
  const devices = adb.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices'))
    .filter((line) => /\sdevice$/.test(line));
  if (devices.length === 0) return { ok: false, detail: 'adb lists no ready devices' };
  return { ok: true, detail: devices.join('; ') };
}

function addCheck({ label, ok, detail, fix, required }) {
  checks.push({ label, ok, detail, fix, required });
}

function printChecks(items) {
  console.log('native-e2e-doctor');
  for (const item of items) {
    const status = item.ok ? 'pass' : item.required ? 'fail' : 'warn';
    console.log(`[${status}] ${item.label}: ${item.detail}`);
    if (!item.ok && item.fix) console.log(`       ${item.fix}`);
  }
}

function parseArgs(args) {
  const parsed = {
    apiBase: undefined,
    appId: undefined,
    dryRun: false,
    expoUrl: undefined,
    platform: undefined,
    profile: undefined,
    requireMaestro: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--require-maestro') {
      parsed.requireMaestro = true;
      continue;
    }
    if (arg === '--api-base') {
      parsed.apiBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--app-id') {
      parsed.appId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--expo-url') {
      parsed.expoUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--platform') {
      parsed.platform = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--profile') {
      parsed.profile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function validatePlatform(value) {
  if (value === 'auto' || value === 'ios' || value === 'android' || value === 'all') return;
  throw new Error(`--platform must be auto, ios, android, or all; got ${value}`);
}

function normalizeBaseUrl(value) {
  return value?.trim().replace(/\/$/, '') || null;
}

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
