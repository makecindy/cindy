#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveJavaRuntimeEnv } from './java-runtime-env.mjs';
import { resolveMobileE2eProfile } from './mobile-e2e-profile.mjs';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const flowRoot = resolve(mobileRoot, 'e2e', 'maestro');
const doctorScript = resolve(scriptDir, 'native-e2e-doctor.mjs');
const defaultAppId = 'com.xd.cindy';

const options = parseArgs(process.argv.slice(2));
const profile = resolveMobileE2eProfile(options.profile ?? process.env.XDT_MOBILE_E2E_PROFILE);
const appId = options.appId ?? process.env.XDT_MOBILE_E2E_APP_ID ?? profile?.appId ?? defaultAppId;
const platform = options.platform ?? process.env.XDT_MOBILE_E2E_PLATFORM ?? profile?.platform ?? 'auto';
const clearState = normalizeBooleanEnv(
  options.clearState
    ?? process.env.XDT_MOBILE_E2E_CLEAR_STATE
    ?? (appId === 'host.exp.Exponent' ? 'false' : 'true'),
  'clearState',
);
const expoUrl = options.expoUrl
  ?? process.env.XDT_MOBILE_E2E_EXPO_URL
  ?? profile?.expoUrl
  ?? (isExpoGoAppId(appId) ? defaultExpoUrlForPlatform(platform) : undefined);
const hostDeviceId = process.env.XDT_MOBILE_E2E_HOST_DEVICE_ID ?? 'mobile-e2e-host';
const hostDeviceChipId = process.env.XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID
  ?? `home.deviceChip.${sanitizeTestIdSegment(hostDeviceId)}`;
const hostAutomationsUrl = process.env.XDT_MOBILE_E2E_HOST_AUTOMATIONS_URL
  ?? (expoUrl ? expoUrlWithRoute(expoUrl, `/automations/${encodeURIComponent(hostDeviceId)}`) : '');
const expoLaunchDelayMs = parseNonNegativeInteger(
  process.env.XDT_MOBILE_E2E_EXPO_LAUNCH_DELAY_MS ?? '20000',
  'XDT_MOBILE_E2E_EXPO_LAUNCH_DELAY_MS',
);
const expoTerminateBeforeOpen = normalizeBooleanEnv(
  process.env.XDT_MOBILE_E2E_EXPO_TERMINATE_BEFORE_OPEN ?? 'true',
  'XDT_MOBILE_E2E_EXPO_TERMINATE_BEFORE_OPEN',
);
const expoOpenBeforeTest = normalizeBooleanEnv(
  process.env.XDT_MOBILE_E2E_EXPO_OPEN_BEFORE_TEST ?? 'true',
  'XDT_MOBILE_E2E_EXPO_OPEN_BEFORE_TEST',
);
const toolEnv = resolveJavaRuntimeEnv(process.env);
const flows = options.flows.length > 0
  ? options.flows
  : splitEnv(process.env.XDT_MOBILE_E2E_FLOWS) ?? ['remote_control_smoke.yaml'];

const resolvedFlows = flows.map((flow) =>
  flow.includes('/') || flow.includes('\\') ? resolve(mobileRoot, flow) : resolve(flowRoot, flow),
);

for (const flow of resolvedFlows) {
  if (!existsSync(flow)) {
    throw new Error(`Maestro flow does not exist: ${flow}`);
  }
}

if (options.dryRun) {
  console.log(`maestro dry run: APP_ID=${appId}`);
  console.log(`- profile: ${profile?.name ?? '<none>'}`);
  console.log(`- platform: ${platform}`);
  console.log(`- clear state: ${clearState}`);
  if (expoUrl) console.log(`- expo url: ${expoUrl}`);
  if (expoUrl) console.log(`- expo launch delay: ${expoLaunchDelayMs}ms`);
  if (expoUrl) console.log(`- expo terminate before open: ${expoTerminateBeforeOpen}`);
  if (expoUrl) console.log(`- expo open before test: ${expoOpenBeforeTest}`);
  console.log(`- host device chip id: ${hostDeviceChipId}`);
  if (hostAutomationsUrl) console.log(`- host automations url: ${hostAutomationsUrl}`);
  for (const flow of resolvedFlows) console.log(`- ${flow}`);
  process.exit(0);
}

if (!options.skipDoctor) {
  runNodeScript(doctorScript, [
    '--require-maestro',
    '--platform',
    platform,
    '--app-id',
    appId,
    ...(expoUrl ? ['--expo-url', expoUrl] : []),
  ]);
} else {
  assertMaestroInstalled();
}

for (const flow of resolvedFlows) {
  if (expoUrl && expoTerminateBeforeOpen === 'true') terminateExpoApp(platform);
  if (expoUrl && expoOpenBeforeTest === 'true') openExpoUrl(expoUrl, platform);
  if (!expoUrl) {
    terminateApp(appId, platform);
    launchNativeApp(appId, platform);
    sleepSync(expoLaunchDelayMs);
  }
  const result = spawnSync(
    'maestro',
    [
      'test',
      '-e',
      `APP_ID=${appId}`,
      '-e',
      `CLEAR_STATE=${clearState}`,
      '-e',
      `XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID=${hostDeviceChipId}`,
      '-e',
      `XDT_MOBILE_E2E_HOST_DEVICE_ID=${hostDeviceId}`,
      '-e',
      `XDT_MOBILE_E2E_EXPO_URL=${expoUrl ?? ''}`,
      '-e',
      `XDT_MOBILE_E2E_HOST_AUTOMATIONS_URL=${hostAutomationsUrl}`,
      flow,
    ],
    {
      cwd: mobileRoot,
      env: {
        ...toolEnv,
        MAESTRO_DRIVER_STARTUP_TIMEOUT: process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT ?? '120000',
        APP_ID: appId,
        CLEAR_STATE: clearState,
        XDT_MOBILE_E2E_EXPO_URL: expoUrl ?? '',
        XDT_MOBILE_E2E_HOST_AUTOMATIONS_URL: hostAutomationsUrl,
      },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(args) {
  const parsed = {
    clearState: undefined,
    appId: undefined,
    dryRun: false,
    expoUrl: undefined,
    flows: [],
    platform: undefined,
    profile: undefined,
    skipDoctor: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--skip-doctor') {
      parsed.skipDoctor = true;
      continue;
    }
    if (arg === '--app-id') {
      const value = args[index + 1];
      if (!value) throw new Error('--app-id requires a value');
      parsed.appId = value;
      index += 1;
      continue;
    }
    if (arg === '--clear-state') {
      const value = args[index + 1];
      if (!value) throw new Error('--clear-state requires a value');
      parsed.clearState = value;
      index += 1;
      continue;
    }
    if (arg === '--no-clear-state') {
      parsed.clearState = 'false';
      continue;
    }
    if (arg === '--expo-url') {
      const value = args[index + 1];
      if (!value) throw new Error('--expo-url requires a value');
      parsed.expoUrl = value;
      index += 1;
      continue;
    }
    if (arg === '--platform') {
      const value = args[index + 1];
      if (!value) throw new Error('--platform requires a value');
      if (value !== 'auto' && value !== 'ios' && value !== 'android') {
        throw new Error('--platform must be auto, ios, or android');
      }
      parsed.platform = value;
      index += 1;
      continue;
    }
    if (arg === '--profile') {
      const value = args[index + 1];
      if (!value) throw new Error('--profile requires a value');
      parsed.profile = value;
      index += 1;
      continue;
    }
    if (arg === '--flow') {
      const value = args[index + 1];
      if (!value) throw new Error('--flow requires a value');
      parsed.flows.push(value);
      index += 1;
      continue;
    }
    parsed.flows.push(arg);
  }
  return parsed;
}

function sanitizeTestIdSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function expoUrlWithRoute(url, route) {
  const marker = '--/';
  const routeValue = String(route).replace(/^\/+/, '');
  const markerIndex = url.indexOf(marker);
  if (markerIndex >= 0) {
    return `${url.slice(0, markerIndex + marker.length)}${routeValue}`;
  }
  return `${url.replace(/\/+$/, '')}/${marker}${routeValue}`;
}

function openExpoUrl(url, platform) {
  const targetPlatform = resolveExpoOpenPlatform(platform);
  if (targetPlatform === 'ios') {
    if (expoTerminateBeforeOpen === 'true') terminateExpoApp(platform);
    const result = spawnSync('xcrun', ['simctl', 'openurl', 'booted', url], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`Failed to open Expo URL ${url}: ${result.stderr || result.stdout || result.status}`);
    }
    sleepSync(expoLaunchDelayMs);
    return;
  }

  const result = spawnSync('adb', [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    url,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Failed to open Expo URL ${url} on Android: ${result.stderr || result.stdout || result.status}`);
  }
  sleepSync(expoLaunchDelayMs);
}

function terminateExpoApp(platform) {
  terminateApp(resolveExpoOpenPlatform(platform) === 'ios' ? 'host.exp.Exponent' : 'host.exp.exponent', platform);
}

function terminateApp(targetAppId, platform) {
  const targetPlatform = resolveExpoOpenPlatform(platform);
  if (targetPlatform === 'ios') {
    spawnSync('xcrun', ['simctl', 'terminate', 'booted', targetAppId], { encoding: 'utf8' });
    return;
  }
  spawnSync('adb', ['shell', 'am', 'force-stop', targetAppId], { encoding: 'utf8' });
}

function launchNativeApp(targetAppId, platform) {
  const targetPlatform = resolveExpoOpenPlatform(platform);
  if (targetPlatform === 'ios') {
    spawnSync('xcrun', ['simctl', 'launch', 'booted', targetAppId], { encoding: 'utf8' });
    return;
  }
  spawnSync('adb', ['shell', 'monkey', '-p', targetAppId, '1'], { encoding: 'utf8' });
}

function resolveExpoOpenPlatform(platform) {
  if (platform === 'ios' || platform === 'android') return platform;
  if (process.platform === 'darwin') {
    const booted = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], { encoding: 'utf8' });
    if (booted.status === 0 && booted.stdout.includes('(Booted)')) return 'ios';
  }
  return 'android';
}

function isExpoGoAppId(appId) {
  return appId === 'host.exp.Exponent' || appId === 'host.exp.exponent';
}

function defaultExpoUrlForPlatform(platform) {
  return platform === 'android' ? 'exp://10.0.2.2:8081/--/devices' : 'exp://localhost:8081/--/devices';
}

function assertMaestroInstalled() {
  const version = spawnSync('maestro', ['--version'], { encoding: 'utf8', env: toolEnv });
  if (version.error) {
    console.error([
      'Maestro CLI is required for native mobile E2E.',
      'Install it first, then re-run this script:',
      '  curl -Ls "https://get.maestro.mobile.dev" | bash',
      '',
      `Flow files are ready under ${flowRoot}`,
    ].join('\n'));
    process.exit(127);
  }
  if (version.status !== 0) process.exit(version.status ?? 1);
}

function runNodeScript(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: mobileRoot,
    env: toolEnv,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function normalizeBooleanEnv(value, label) {
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return 'true';
  if (text === 'false' || text === '0' || text === 'no') return 'false';
  throw new Error(`${label} must be true or false`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function splitEnv(value) {
  if (!value?.trim()) return null;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}
