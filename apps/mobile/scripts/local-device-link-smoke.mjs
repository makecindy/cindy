#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMobileE2eProfile } from './mobile-e2e-profile.mjs';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const maestroScript = resolve(scriptDir, 'maestro-e2e.mjs');
const maestroCheckScript = resolve(scriptDir, 'maestro-flow-smoke.mjs');
const mockHostScript = resolve(scriptDir, 'mock-device-link-host.mjs');
const mockVoiceProxyScript = resolve(scriptDir, 'mock-voice-proxy.mjs');
const voiceCloudPreflightScript = resolve(scriptDir, 'mobile-voice-cloud-preflight.mjs');
const defaultAppId = 'com.xd.cindy';
const defaultApiBase = 'http://localhost:3333';
const defaultFlow = 'remote_session_smoke.yaml';
const defaultVoiceProxyPort = 3345;
const cleanupDeviceId = 'mobile-e2e-cleaner';
const e2eDeviceIdPrefixes = ['mobile-e2e-', 'visual-'];

loadEnvFile(resolve(mobileRoot, '.env'));

const options = parseArgs(process.argv.slice(2));
const profile = resolveMobileE2eProfile(options.profile ?? process.env.XDT_MOBILE_E2E_PROFILE);
const apiBase = normalizeBaseUrl(
  options.apiBase
    ?? process.env.XDT_MOBILE_E2E_API_BASE_URL
    ?? defaultApiBase,
);
const deviceLinkApiBase = normalizeBaseUrl(
  options.deviceLinkBase
    ?? process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL
    ?? process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL
    ?? deriveDeviceLinkApiBase(apiBase),
);
if (options.startExpo) {
  process.env.EXPO_PUBLIC_XDT_API_BASE_URL = apiBase;
  process.env.XDT_MOBILE_E2E_API_BASE_URL = apiBase;
  process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL = deviceLinkApiBase;
  process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL = deviceLinkApiBase;
  process.env.EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED = '1';
}
const appConfiguredApiBase = process.env.EXPO_PUBLIC_XDT_API_BASE_URL
  ? normalizeBaseUrl(process.env.EXPO_PUBLIC_XDT_API_BASE_URL)
  : null;
const appId = options.appId ?? process.env.XDT_MOBILE_E2E_APP_ID ?? profile?.appId ?? defaultAppId;
const platform = options.platform ?? process.env.XDT_MOBILE_E2E_PLATFORM ?? profile?.platform ?? 'auto';
const expoUrl = options.expoUrl ?? process.env.XDT_MOBILE_E2E_EXPO_URL ?? profile?.expoUrl;
const flowSuite = options.flowSuite ?? process.env.XDT_MOBILE_E2E_FLOW_SUITE;
const flows = resolveFlows({
  flow: options.flow ?? process.env.XDT_MOBILE_E2E_FLOW,
  appId,
  flowSuite,
});
const configuredMockHostScenario = options.mockHostScenario
  ?? process.env.XDT_MOBILE_E2E_MOCK_SCENARIO;
const mockHostScenario = configuredMockHostScenario
  ?? defaultMockHostScenarioForSuite(flowSuite);
const mockHostRealDb = options.mockHostRealDb ?? process.env.XDT_MOBILE_E2E_REAL_DB_PATH;
const probeDeviceId = options.probeDeviceId ?? process.env.XDT_MOBILE_E2E_PROBE_DEVICE_ID ?? 'mobile-e2e-probe';
const mockHostDeviceId = options.mockHostDeviceId ?? process.env.XDT_MOBILE_E2E_HOST_DEVICE_ID ?? 'mobile-e2e-host';
const mockHostDeviceChipId = `home.deviceChip.${sanitizeTestIdSegment(mockHostDeviceId)}`;
const configuredVoiceProxyBaseUrl = options.voiceProxyBaseUrl ?? process.env.XDT_MOBILE_E2E_VOICE_PROXY_BASE_URL ?? null;
const voiceProxySelected = options.mockVoiceProxy || !!configuredVoiceProxyBaseUrl || flows.includes('voice_input_smoke.yaml');
const voiceProxyPort = parsePositiveInteger(options.voiceProxyPort ?? process.env.XDT_MOBILE_E2E_VOICE_PROXY_PORT, defaultVoiceProxyPort);
const voiceProxyBaseUrl = configuredVoiceProxyBaseUrl
  ?? (voiceProxySelected ? resolveVoiceProxyBaseUrl(platform, voiceProxyPort) : null);
const startLocalVoiceProxy = voiceProxySelected && !configuredVoiceProxyBaseUrl;
const voiceProxyHealthBaseUrl = startLocalVoiceProxy ? `http://localhost:${voiceProxyPort}` : voiceProxyBaseUrl;
const useMockAudio = voiceProxySelected && !options.noMockAudio;
if (options.startExpo && useMockAudio) {
  process.env.EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO = '1';
}
if (options.startExpo && voiceProxyBaseUrl) {
  process.env.EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL = voiceProxyBaseUrl;
  // 托管语音面:手机只保留官方托管路径后,voice smoke 经 mock 的
  // /api/voice/sessions 换票再连本 mock 的 realtime 端点。
  process.env.EXPO_PUBLIC_CINDY_VOICE_API_BASE_URL = voiceProxyBaseUrl;
}
const waitForReadyMs = options.waitForReadyMs
  ?? (options.mockHost || options.startServer ? 20_000 : 0);
const waitForExpoReadyMs = options.startExpo ? Math.max(waitForReadyMs, 60_000) : 0;
const isolateMockHostFlows = options.mockHost
  && !options.checkOnly
  && (flowSuite === 'visual' || flowSuite === 'full' || flowSuite === 'file' || flowSuite === 'automations')
  && !options.flow
  && flows.length > 1;
const cleanupTasks = [];
let activeMockHostStop = null;

process.env.XDT_MOBILE_E2E_HOST_DEVICE_ID = mockHostDeviceId;
process.env.XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID = mockHostDeviceChipId;

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

if (options.dryRun) {
  console.log('local-device-link-smoke dry run');
  console.log(`- api base: ${apiBase}`);
  console.log(`- device-link api base: ${deviceLinkApiBase}`);
  console.log(`- app id: ${appId}`);
  console.log(`- profile: ${profile?.name ?? '<none>'}`);
  console.log(`- platform: ${platform}`);
  if (expoUrl) console.log(`- expo url: ${expoUrl}`);
  console.log(`- flow suite: ${flowSuite ?? 'custom'}`);
  console.log(`- flows: ${flows.join(', ')}`);
  console.log(`- probe device id: ${probeDeviceId}`);
  console.log(`- mock host chip id: ${mockHostDeviceChipId}`);
  console.log(`- start server: ${options.startServer ? 'yes' : 'no'}`);
  console.log(`- start expo: ${options.startExpo ? 'yes' : 'no'}`);
  console.log(`- mock host: ${options.mockHost ? `${mockHostDeviceId} (${mockHostRealDb ? 'real-db' : mockHostScenario})` : 'no'}`);
  if (options.mockHost && isolateMockHostFlows && !configuredMockHostScenario && !mockHostRealDb) {
    console.log(`- mock host flow scenarios: ${flows.map((flow) => `${flow}:${mockHostScenarioForFlow(flow)}`).join(', ')}`);
  }
  if (mockHostRealDb) console.log(`- mock host real db: ${mockHostRealDb}`);
  if (voiceProxySelected) console.log(`- voice proxy: ${voiceProxyBaseUrl}`);
  if (options.voiceCloudPreflight) {
    console.log('- voice cloud preflight: yes');
    console.log(`- voice cloud candidates: ${options.voiceCloudAllCandidates ? 'all ASR/refine provider candidates' : 'primary candidate only'}`);
  }
  console.log(`- wait for ready: ${waitForReadyMs}ms`);
  if (options.startServer) console.log('- server command: pnpm dev:server');
  if (options.startExpo) {
    const expoServer = resolveExpoServer(expoUrl);
    console.log(`- expo command: pnpm start -- --host ${expoServer.startHost} --port ${expoServer.port}`);
    console.log(`- expo status: ${expoServer.statusUrl}`);
    if (voiceProxySelected) console.log(`- expo mock audio: ${useMockAudio ? 'yes' : 'no'}`);
  }
  if (options.mockHost) {
    if (startLocalVoiceProxy) console.log(`- voice proxy command: node ${mockVoiceProxyScript} --port ${voiceProxyPort}`);
    console.log(`- mock host command: node ${mockHostScript} --api-base ${apiBase} --device-link-base ${deviceLinkApiBase} --device-id ${mockHostDeviceId} --scenario ${mockHostScenario}${mockHostRealDb ? ` --real-db ${mockHostRealDb}` : ''}`);
  }
  console.log(`- maestro command: node ${maestroScript}${profile ? ` --profile ${profile.name}` : ''} --app-id ${appId} --platform ${platform}${expoUrl ? ` --expo-url ${expoUrl}` : ''}${flows.map((item) => ` --flow ${item}`).join('')}`);
  process.exit(0);
}

runNodeScript(maestroCheckScript);

if (appConfiguredApiBase && appConfiguredApiBase !== apiBase) {
  console.warn(
    [
      `EXPO_PUBLIC_XDT_API_BASE_URL is ${appConfiguredApiBase}, but local smoke is probing ${apiBase}.`,
      'Make sure the running app was started with the same local API base, or pass --api-base to this script.',
    ].join('\n'),
  );
}

if (options.startServer) {
  startServerProcess();
}

if (options.startExpo) {
  await startExpoProcess(expoUrl);
}

if (expoUrl && (!options.checkOnly || options.startExpo)) {
  await assertExpoReady(expoUrl, { waitForReadyMs: waitForExpoReadyMs });
}

if (options.mockHost && startLocalVoiceProxy) {
  startMockVoiceProxyProcess(voiceProxyPort);
  await assertVoiceProxyReady(voiceProxyHealthBaseUrl, { waitForReadyMs });
}

if (options.voiceCloudPreflight) {
  runVoiceCloudPreflight();
}

if (isolateMockHostFlows) {
  for (const flow of flows) {
    const flowMockHostDeviceId = flowSuite === 'visual' ? `${mockHostDeviceId}-${flowSlug(flow)}` : mockHostDeviceId;
    const flowMockHostDeviceChipId = `home.deviceChip.${sanitizeTestIdSegment(flowMockHostDeviceId)}`;
    const flowMockHostScenario = mockHostScenarioForFlow(flow);
    process.env.XDT_MOBILE_E2E_HOST_DEVICE_ID = flowMockHostDeviceId;
    process.env.XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID = flowMockHostDeviceChipId;
    await cleanupE2eDeviceRecords(apiBase, flowMockHostDeviceId);
    const stopMockHost = startMockHostProcess(apiBase, flowMockHostDeviceId, flowMockHostScenario, mockHostRealDb);
    await stopMockHost.ready;
    await assertServerReady(apiBase, probeDeviceId, { waitForReadyMs, expectedControllableDeviceId: flowMockHostDeviceId });
    runNodeScript(maestroScript, maestroArgsForFlows([flow]));
    stopMockHost();
    removeCleanupTask(stopMockHost);
    await sleep(500);
    await cleanupE2eDeviceRecords(apiBase, flowMockHostDeviceId);
  }
  await cleanupE2eDeviceRecords(apiBase, mockHostDeviceId);
  cleanup();
  process.exit(0);
}

if (options.mockHost) {
  await cleanupE2eDeviceRecords(apiBase, mockHostDeviceId);
  const stopMockHost = startMockHostProcess(apiBase, mockHostDeviceId, mockHostScenario, mockHostRealDb);
  activeMockHostStop = stopMockHost;
  await stopMockHost.ready;
}

await assertServerReady(apiBase, probeDeviceId, {
  waitForReadyMs,
  expectedControllableDeviceId: options.mockHost ? mockHostDeviceId : undefined,
});

if (options.checkOnly) {
  console.log('local-device-link-smoke preflight passed; skipped Maestro because --check-only was set');
  await stopActiveMockHost();
  if (options.mockHost) await cleanupE2eDeviceRecords(apiBase, mockHostDeviceId);
  cleanup();
  process.exit(0);
}

runNodeScript(maestroScript, maestroArgsForFlows(flows));
await stopActiveMockHost();
if (options.mockHost) await cleanupE2eDeviceRecords(apiBase, mockHostDeviceId);
cleanup();

function maestroArgsForFlows(selectedFlows) {
  return [
    ...(profile ? ['--profile', profile.name] : []),
    '--app-id',
    appId,
    '--platform',
    platform,
    ...(expoUrl ? ['--expo-url', expoUrl] : []),
    ...selectedFlows.flatMap((flow) => ['--flow', flow]),
  ];
}

function defaultMockHostScenarioForSuite(suite) {
  if (suite === 'visual') return 'visual';
  if (suite === 'controls') return 'controls';
  if (suite === 'voice') return 'voice';
  return 'basic';
}

function mockHostScenarioForFlow(flow) {
  if (configuredMockHostScenario) return mockHostScenario;
  if (flowSuite === 'full' && flow === 'fixture_controls_smoke.yaml') return 'controls';
  return mockHostScenario;
}

async function assertServerReady(baseUrl, deviceId, { waitForReadyMs = 0, expectedControllableDeviceId } = {}) {
  await waitForJson(`${baseUrl}/api/health`, {
    label: 'server health',
    waitForReadyMs,
    hint: [
      'Start the local server with device-link enabled before running the mobile smoke:',
      '  XDT_DEV_AUTH_ENABLED=1 REDIS_URL=redis://127.0.0.1:6379 pnpm dev:server',
    ].join('\n'),
  });

  const login = await waitForJson(`${baseUrl}/api/auth/dev-login`, {
    label: 'dev login',
    method: 'POST',
    waitForReadyMs,
    body: { deviceId },
    hint: [
      'The local server must enable mock auth for mobile E2E:',
      '  XDT_DEV_AUTH_ENABLED=1 pnpm dev:server',
    ].join('\n'),
  });
  const token = login?.accessToken;
  if (!token || typeof token !== 'string') {
    throw new Error('dev login did not return an accessToken');
  }

  try {
    const devicesPayload = await waitForJson(`${deviceLinkApiBase}/api/device-link/devices`, {
      label: 'device-link devices',
      token,
      waitForReadyMs,
      accept: (payload) => {
        if (options.allowNoControllable) return true;
        const devices = Array.isArray(payload?.devices) ? payload.devices : [];
        return devices.some((device) =>
          isControllableDevice(device)
          && (!expectedControllableDeviceId || device.deviceId === expectedControllableDeviceId),
        );
      },
      hint: [
        'Device-link REST requires REDIS_URL on the local server.',
        'The desktop app also needs to be logged in with the same dev account and remote control enabled.',
        'For automated local fixture testing, pass --mock-host.',
      ].join('\n'),
    });
    const devices = Array.isArray(devicesPayload?.devices) ? devicesPayload.devices : [];
    const controllable = devices.filter(isControllableDevice);
    const expectedControllable = expectedControllableDeviceId
      ? controllable.filter((device) => device.deviceId === expectedControllableDeviceId)
      : controllable;
    if (controllable.length === 0 && !options.allowNoControllable) {
      const summary = devices.map((device) => {
        const name = device.name ?? device.deviceId ?? '<unknown>';
        const flags = [
          device.isSelf ? 'self' : 'remote',
          device.online ? 'online' : 'offline',
          device.remoteControlEnabled ? 'remote-on' : 'remote-off',
        ].join(',');
        return `  - ${name} (${flags})`;
      });
      throw new Error([
        'No controllable desktop device is visible to the local server.',
        'Expected at least one non-self device with online=true and remoteControlEnabled=true.',
        summary.length ? ['Visible devices:', ...summary].join('\n') : 'Visible devices: none',
      ].join('\n'));
    }
    if (expectedControllableDeviceId && expectedControllable.length === 0 && !options.allowNoControllable) {
      const summary = devices.map((device) => {
        const name = device.name ?? device.deviceId ?? '<unknown>';
        const flags = [
          device.isSelf ? 'self' : 'remote',
          device.online ? 'online' : 'offline',
          device.remoteControlEnabled ? 'remote-on' : 'remote-off',
        ].join(',');
        return `  - ${name} (${flags})`;
      });
      throw new Error([
        `Expected mock host ${expectedControllableDeviceId} to be controllable, but it is not ready.`,
        summary.length ? ['Visible devices:', ...summary].join('\n') : 'Visible devices: none',
      ].join('\n'));
    }
    console.log(
      `local-device-link-smoke preflight passed: ${devices.length} device(s), ${controllable.length} controllable`,
    );
  } finally {
    await requestJson(`${baseUrl}/api/auth/logout`, {
      label: 'probe logout',
      method: 'POST',
      token,
      body: { deviceId },
      optional: true,
    });
    if (isE2eDeviceId(deviceId)) {
      await deleteDeviceRecord(baseUrl, token, deviceId);
    }
  }
}

async function cleanupE2eDeviceRecords(baseUrl, hostDeviceId) {
  let token = null;
  try {
    const login = await requestJson(`${baseUrl}/api/auth/dev-login`, {
      label: 'cleanup dev login',
      method: 'POST',
      body: { deviceId: cleanupDeviceId },
      optional: true,
    });
    token = typeof login?.accessToken === 'string' ? login.accessToken : null;
    if (!token) return;
    const payload = await requestJson(`${deviceLinkApiBase}/api/device-link/devices`, {
      label: 'cleanup device list',
      token,
      optional: true,
    });
    const devices = Array.isArray(payload?.devices) ? payload.devices : [];
    for (const device of devices) {
      const deviceId = typeof device?.deviceId === 'string' ? device.deviceId : '';
      if (!deviceId) continue;
      const isTargetHost = hostDeviceId && (deviceId === hostDeviceId || deviceId.startsWith(`${hostDeviceId}-`));
      if (!isTargetHost && (device.online === true || !isE2eDeviceId(deviceId, hostDeviceId))) continue;
      await deleteDeviceRecord(baseUrl, token, deviceId);
    }
  } catch (err) {
    console.warn(`local-device-link-smoke cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (token) {
      await requestJson(`${baseUrl}/api/auth/logout`, {
        label: 'cleanup logout',
        method: 'POST',
        token,
        body: { deviceId: cleanupDeviceId },
        optional: true,
      });
      await deleteDeviceRecord(baseUrl, token, cleanupDeviceId);
    }
  }
}

async function deleteDeviceRecord(baseUrl, token, deviceId) {
  await requestJson(`${deviceLinkApiBase}/api/device-link/devices/${encodeURIComponent(deviceId)}`, {
    label: `delete device ${deviceId}`,
    method: 'DELETE',
    token,
    optional: true,
  });
}

function isE2eDeviceId(deviceId, hostDeviceId = '') {
  if (hostDeviceId && (deviceId === hostDeviceId || deviceId.startsWith(`${hostDeviceId}-`))) return true;
  return e2eDeviceIdPrefixes.some((prefix) => deviceId.startsWith(prefix));
}

function isControllableDevice(device) {
  return device
    && device.isSelf !== true
    && device.online === true
    && device.remoteControlEnabled === true;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`${options.label ?? url} returned ${response.status}: ${text}`);
    }
    return parsed;
  } catch (err) {
    if (options.optional) return null;
    const suffix = options.hint ? `\n${options.hint}` : '';
    throw new Error(`${options.label ?? url} failed: ${err instanceof Error ? err.message : String(err)}${suffix}`);
  } finally {
    clearTimeout(timer);
  }
}

async function requestText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: { Accept: 'text/plain,application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.label ?? url} returned ${response.status}: ${text}`);
    }
    return text;
  } catch (err) {
    if (options.optional) return null;
    const suffix = options.hint ? `\n${options.hint}` : '';
    throw new Error(`${options.label ?? url} failed: ${err instanceof Error ? err.message : String(err)}${suffix}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForJson(url, options = {}) {
  const deadline = Date.now() + (options.waitForReadyMs ?? 0);
  let lastError = null;
  do {
    try {
      const payload = await requestJson(url, options);
      if (!options.accept || options.accept(payload)) return payload;
      lastError = new Error(`${options.label ?? url} is not ready yet`);
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  throw lastError;
}

async function waitForText(url, options = {}) {
  const deadline = Date.now() + (options.waitForReadyMs ?? 0);
  let lastError = null;
  do {
    try {
      const payload = await requestText(url, options);
      if (!options.accept || options.accept(payload)) return payload;
      lastError = new Error(`${options.label ?? url} is not ready yet`);
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  throw lastError;
}

function startServerProcess() {
  const child = spawn(pnpmBin(), ['dev:server'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'server');
  const cleanupTask = () => stopChild(child);
  cleanupTasks.push(cleanupTask);
  console.log('local-device-link-smoke started local server fixture');
  return cleanupTask;
}

function startMockVoiceProxyProcess(port) {
  const child = spawn(process.execPath, [
    mockVoiceProxyScript,
    '--port',
    String(port),
  ], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      XDT_MOBILE_E2E_VOICE_PROXY_PORT: String(port),
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'voice-proxy');
  const cleanupTask = () => stopChild(child);
  cleanupTasks.push(cleanupTask);
  console.log(`local-device-link-smoke started mock voice proxy fixture on port ${port}`);
  return cleanupTask;
}

async function assertVoiceProxyReady(baseUrl, { waitForReadyMs = 0 } = {}) {
  await waitForJson(`${baseUrl}/health`, {
    label: 'mock voice proxy health',
    waitForReadyMs,
    hint: [
      'The voice smoke requires a local mock ASR/refine proxy.',
      `Expected it at ${baseUrl}.`,
    ].join('\n'),
  });
  console.log(`local-device-link-smoke voice proxy preflight passed: ${baseUrl}`);
}

async function startExpoProcess(url) {
  const expoServer = resolveExpoServer(url);
  const existingStatus = await requestText(expoServer.statusUrl, {
    label: 'Expo Metro',
    optional: true,
    timeoutMs: 1000,
  });
  if (isExpoReadyText(existingStatus)) {
    console.log(`local-device-link-smoke reusing Expo server at ${expoServer.statusUrl}`);
    return null;
  }

  const child = spawn(pnpmBin(), ['start', '--', '--host', expoServer.startHost, '--port', expoServer.port], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      CI: process.env.CI ?? '1',
      EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_XDT_API_BASE_URL: apiBase,
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: deviceLinkApiBase,
      EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED: '1',
      ...(voiceProxyBaseUrl ? {
        EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL: voiceProxyBaseUrl,
        EXPO_PUBLIC_CINDY_VOICE_API_BASE_URL: voiceProxyBaseUrl,
      } : {}),
      XDT_MOBILE_E2E_API_BASE_URL: apiBase,
      XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL: deviceLinkApiBase,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'expo');
  const cleanupTask = () => stopChild(child);
  cleanupTasks.push(cleanupTask);
  console.log(`local-device-link-smoke started Expo fixture on ${expoServer.statusUrl}`);
  return cleanupTask;
}

async function assertExpoReady(url, { waitForReadyMs = 0 } = {}) {
  const expoServer = resolveExpoServer(url);
  await waitForText(expoServer.statusUrl, {
    label: 'Expo Metro',
    waitForReadyMs,
    accept: isExpoReadyText,
    hint: [
      'Expo Go native E2E needs Metro before Maestro opens the app.',
      'Pass --start-expo, or start Expo manually with:',
      `  EXPO_PUBLIC_XDT_API_BASE_URL=${apiBase} EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL=${deviceLinkApiBase} pnpm --filter mobile start -- --host ${expoServer.startHost} --port ${expoServer.port}`,
    ].join('\n'),
  });
  console.log(`local-device-link-smoke Expo preflight passed: ${expoServer.statusUrl}`);
}

function startMockHostProcess(baseUrl, hostDeviceId, scenario, realDbPath) {
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error(`mock host did not become ready within ${Math.max(waitForReadyMs, 10_000)}ms: ${hostDeviceId}`));
  }, Math.max(waitForReadyMs, 10_000));
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    resolveReady();
  };
  const child = spawn(process.execPath, [
    mockHostScript,
    '--api-base',
    baseUrl,
    '--device-link-base',
    deviceLinkApiBase,
    '--device-id',
    hostDeviceId,
    '--scenario',
    scenario,
    ...(realDbPath ? ['--real-db', realDbPath] : []),
  ], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      XDT_MOBILE_E2E_API_BASE_URL: baseUrl,
      XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL: deviceLinkApiBase,
      XDT_MOBILE_E2E_HOST_DEVICE_ID: hostDeviceId,
      XDT_MOBILE_E2E_MOCK_SCENARIO: scenario,
      ...(realDbPath ? { XDT_MOBILE_E2E_REAL_DB_PATH: realDbPath } : {}),
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'mock-host', (line) => {
    if (line.includes('mock-device-link-host ready')) markReady();
  });
  child.on('exit', (code, signal) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    rejectReady(new Error(`mock host exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
  });
  const cleanupTask = () => stopChild(child);
  cleanupTask.ready = ready;
  cleanupTasks.push(cleanupTask);
  console.log(`local-device-link-smoke started mock host fixture: ${hostDeviceId}${realDbPath ? ' (real-db)' : ''}`);
  return cleanupTask;
}

function pipeChildOutput(child, label, onStdoutLine) {
  child.stdout?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.log(`[${label}] ${line}`);
      onStdoutLine?.(line);
    }
  });
  child.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.error(`[${label}] ${line}`);
    }
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 2_000).unref();
}

function cleanup() {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    try {
      task?.();
    } catch {
      // best effort
    }
  }
}

async function stopActiveMockHost() {
  if (!activeMockHostStop) return;
  const task = activeMockHostStop;
  activeMockHostStop = null;
  task();
  removeCleanupTask(task);
  await sleep(500);
}

function removeCleanupTask(task) {
  const index = cleanupTasks.lastIndexOf(task);
  if (index !== -1) cleanupTasks.splice(index, 1);
}

function flowSlug(flow) {
  return flow
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function runNodeScript(script, args = [], envOverrides = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: mobileRoot,
    env: { ...process.env, ...envOverrides },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    cleanup();
    process.exit(result.status ?? 1);
  }
}

function runVoiceCloudPreflight() {
  const args = [
    '--run',
    ...(options.voiceCloudAllCandidates ? ['--all-candidates'] : []),
  ];
  const preflightEnv = {};
  if (voiceProxyBaseUrl) {
    preflightEnv.XDT_MOBILE_VOICE_PROXY_BASE_URL = voiceProxyBaseUrl;
    if (process.env.XDT_MOBILE_VOICE_PROXY_API_KEY) {
      preflightEnv.XDT_MOBILE_VOICE_PROXY_API_KEY = process.env.XDT_MOBILE_VOICE_PROXY_API_KEY;
    } else if (startLocalVoiceProxy) {
      preflightEnv.XDT_MOBILE_VOICE_PROXY_API_KEY = 'sk-mock-mobile-voice-key';
    }
  }
  console.log('local-device-link-smoke running voice cloud preflight');
  runNodeScript(voiceCloudPreflightScript, args, preflightEnv);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function sanitizeTestIdSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function parseArgs(args) {
  const parsed = {
    allowNoControllable: false,
    apiBase: undefined,
    deviceLinkBase: undefined,
    appId: undefined,
    checkOnly: false,
    dryRun: false,
    flow: undefined,
    flowSuite: undefined,
    expoUrl: undefined,
    mockHost: false,
    mockHostDeviceId: undefined,
    mockHostRealDb: undefined,
    mockHostScenario: undefined,
    mockVoiceProxy: false,
    noMockAudio: process.env.XDT_MOBILE_E2E_NO_MOCK_AUDIO === '1',
    platform: undefined,
    probeDeviceId: undefined,
    profile: undefined,
    startServer: false,
    startExpo: false,
    voiceCloudAllCandidates: process.env.XDT_MOBILE_E2E_VOICE_CLOUD_ALL_CANDIDATES === '1',
    voiceCloudPreflight: process.env.XDT_MOBILE_E2E_VOICE_CLOUD_PREFLIGHT === '1',
    voiceProxyBaseUrl: undefined,
    voiceProxyPort: undefined,
    waitForReadyMs: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--allow-no-controllable') {
      parsed.allowNoControllable = true;
      continue;
    }
    if (arg === '--check-only') {
      parsed.checkOnly = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--mock-host') {
      parsed.mockHost = true;
      continue;
    }
    if (arg === '--mock-voice-proxy') {
      parsed.mockVoiceProxy = true;
      continue;
    }
    if (arg === '--voice-cloud-preflight') {
      parsed.voiceCloudPreflight = true;
      continue;
    }
    if (arg === '--voice-cloud-all-candidates') {
      parsed.voiceCloudAllCandidates = true;
      continue;
    }
    if (arg === '--no-mock-audio') {
      parsed.noMockAudio = true;
      continue;
    }
    if (arg === '--start-server') {
      parsed.startServer = true;
      continue;
    }
    if (arg === '--start-expo') {
      parsed.startExpo = true;
      continue;
    }
    if (arg === '--api-base') {
      parsed.apiBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--device-link-base') {
      parsed.deviceLinkBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--app-id') {
      parsed.appId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--flow') {
      parsed.flow = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--flow-suite') {
      parsed.flowSuite = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--expo-url') {
      parsed.expoUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--probe-device-id') {
      parsed.probeDeviceId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--mock-host-device-id') {
      parsed.mockHostDeviceId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--mock-host-scenario') {
      parsed.mockHostScenario = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--voice-proxy-base-url') {
      parsed.voiceProxyBaseUrl = normalizeBaseUrl(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--voice-proxy-port') {
      const raw = readValue(args, index, arg);
      parsed.voiceProxyPort = parsePositiveInteger(raw, NaN);
      if (!Number.isFinite(parsed.voiceProxyPort)) {
        throw new Error(`${arg} requires a positive number`);
      }
      index += 1;
      continue;
    }
    if (arg === '--mock-host-real-db' || arg === '--real-db') {
      parsed.mockHostRealDb = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--platform') {
      parsed.platform = readValue(args, index, arg);
      if (parsed.platform !== 'auto' && parsed.platform !== 'ios' && parsed.platform !== 'android') {
        throw new Error('--platform must be auto, ios, or android');
      }
      index += 1;
      continue;
    }
    if (arg === '--profile') {
      parsed.profile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wait-for-ready-ms') {
      const raw = readValue(args, index, arg);
      const parsedValue = Number(raw);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        throw new Error(`${arg} requires a non-negative number`);
      }
      parsed.waitForReadyMs = parsedValue;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function resolveFlows({ appId, flow, flowSuite }) {
  if (flow) return [flow];
  if (!flowSuite) return [defaultFlow];
  if (flowSuite === 'default') return [defaultFlow];
  if (flowSuite === 'create') return ['create_session_smoke.yaml'];
  if (flowSuite === 'controls') return ['fixture_controls_smoke.yaml'];
  if (flowSuite === 'voice') return ['voice_input_smoke.yaml'];
  if (flowSuite === 'media') {
    return [
      appId === 'host.exp.Exponent' ? 'media_smoke_expo_go.yaml' : 'media_smoke.yaml',
      'file_preview.yaml',
    ];
  }
  if (flowSuite === 'file') return ['file_preview.yaml', 'file_browser.yaml'];
  if (flowSuite === 'automations') return ['automations.yaml', 'automations_create_edit.yaml'];
  if (flowSuite === 'visual') {
    return [
      'visual_smoke.yaml',
      'visual_session_list_controls.yaml',
      'visual_new_session.yaml',
      'visual_files.yaml',
      'visual_automations.yaml',
      'visual_session_idle.yaml',
      'visual_session_controls_session.yaml',
      'visual_session_controls_usage.yaml',
      'visual_session_running.yaml',
      'visual_session_queue.yaml',
      'visual_session_pending.yaml',
      'visual_session_permission.yaml',
      'visual_session_ask.yaml',
      'visual_session_payload.yaml',
      'visual_session_offline.yaml',
      'visual_session_revoked.yaml',
    ];
  }
  if (flowSuite === 'full') {
    return [
      'create_session_smoke.yaml',
      'remote_session_smoke.yaml',
      'voice_input_smoke.yaml',
      'fixture_controls_smoke.yaml',
      appId === 'host.exp.Exponent' ? 'media_smoke_expo_go.yaml' : 'media_smoke.yaml',
      'file_preview.yaml',
      'file_browser.yaml',
      'fork_rewind.yaml',
      'message_selection.yaml',
      'automations.yaml',
      'automations_create_edit.yaml',
      'settings.yaml',
    ];
  }
  throw new Error(`Unknown flow suite: ${flowSuite}`);
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/$/, '');
}

// deriveDeviceLinkApiBase 收敛至共享 lib(仅本地 3333→3335 端口推导;生产域名分支已随 apiBaseUrl 退役删除)
import { deriveDeviceLinkApiBase } from './lib/device-link-base.mjs';

function parsePositiveInteger(value, fallback) {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function resolveVoiceProxyBaseUrl(targetPlatform, port) {
  if (targetPlatform === 'android') return `http://10.0.2.2:${port}`;
  return `http://localhost:${port}`;
}

function resolveExpoServer(url) {
  if (!url) {
    return {
      host: 'localhost',
      port: '8081',
      startHost: 'localhost',
      statusUrl: 'http://localhost:8081/status',
    };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Expo URL: ${url}`);
  }
  if (parsed.protocol !== 'exp:') {
    throw new Error(`Expo URL must use exp://, got: ${url}`);
  }
  const port = parsed.port || '8081';
  const host = parsed.hostname || 'localhost';
  const statusHost = host === '10.0.2.2' || host === '127.0.0.1' || host === '::1'
    ? 'localhost'
    : host;
  const startHost = host === '10.0.2.2' || host === '127.0.0.1' || host === '::1'
    ? 'localhost'
    : host === 'localhost'
      ? 'localhost'
      : 'lan';
  return {
    host,
    port,
    startHost,
    statusUrl: `http://${statusHost}:${port}/status`,
  };
}

function isExpoReadyText(value) {
  return typeof value === 'string' && value.toLowerCase().includes('running');
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
