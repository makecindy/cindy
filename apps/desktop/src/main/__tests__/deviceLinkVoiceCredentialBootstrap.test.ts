/**
 * Locks the real Electron desktop path for device-link voice channels.
 *
 * Mobile voice credential sync itself is removed (mobile voice input now uses
 * the managed Cindy voice service); the channel stays matched so old mobile
 * builds get a readable rejection. This source guard prevents a future
 * bootstrap refactor from leaving dispatch unreachable from the running
 * desktop DeviceLinkClient.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const mainRoot = resolve(__dirname, '..');

describe('mobile voice credential sync desktop bootstrap path', () => {
  it('starts device-link service from Electron bootstrap', () => {
    const bootstrap = readFileSync(resolve(mainRoot, 'bootstrap-electron.ts'), 'utf8');

    expect(bootstrap).toMatch(/import \{[^}]*\binitDeviceLinkService\b[^}]*\} from '\.\/device-link';/);
    const serviceInit = bootstrap.search(/\binitDeviceLinkService\s*\(\s*\{/);
    const ipcRegistration = bootstrap.search(/\bregisterDeviceLinkIpc\s*\(\s*\)\s*;/);
    expect(serviceInit).toBeGreaterThanOrEqual(0);
    expect(ipcRegistration).toBeGreaterThanOrEqual(0);
    expect(serviceInit).toBeLessThan(ipcRegistration);
  });

  it('wires the DeviceLinkClient inbound frames into controlled-desktop dispatch', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('wireInboundDispatch,');
    const listenerRegistration = deviceLinkHost.search(
      /\bsetControllersChangedListener\s*\(\s*\(\s*controllers\s*,\s*updateRelaunchControllers\s*\)\s*=>/,
    );
    const inboundWiring = deviceLinkHost.search(/\bwireInboundDispatch\s*\(\s*client\s*\)\s*;/);
    expect(listenerRegistration).toBeGreaterThanOrEqual(0);
    expect(inboundWiring).toBeGreaterThanOrEqual(0);
    expect(listenerRegistration).toBeLessThan(inboundWiring);
  });

  it('replays desktop subscriptions when a remote device becomes controllable again', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('const available = snap.online && snap.remoteControlEnabled;');
    // `!== true` 而非 `=== false`:断线时 availability 视图整体清空,重连后首帧
    // presence(wasAvailable=undefined)同样必须触发重放——它是 DEVICE_OFFLINE
    // 永久放弃后的唯一恢复事件(#1520 review P1)。
    expect(deviceLinkHost).toContain('if (available && wasAvailable !== true)');
    expect(deviceLinkHost).toContain('replayActiveSubscriptions(`presence-online:${snap.deviceId.slice(0, 8)}`, snap.deviceId);');
  });

  it('每个 relay 连接代上线时从设备目录补齐已在线控制端展示名', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain("serverApiFetch<DeviceDirectoryResponse>('/api/device-link/devices'");
    const onlineBranch = deviceLinkHost.indexOf("if (status === 'online') {");
    const seedCachedNames = deviceLinkHost.indexOf(
      'seedControllerDisplayNamesFromLastKnown();',
      onlineBranch,
    );
    const refreshDirectory = deviceLinkHost.indexOf(
      'void refreshControllerDisplayNamesFromDirectory(displayNameGeneration);',
      onlineBranch,
    );
    const replaySubscriptions = deviceLinkHost.indexOf(
      "replayActiveSubscriptions('ws-online');",
      onlineBranch,
    );
    expect(onlineBranch).toBeGreaterThanOrEqual(0);
    expect(seedCachedNames).toBeGreaterThan(onlineBranch);
    expect(refreshDirectory).toBeGreaterThan(seedCachedNames);
    expect(replaySubscriptions).toBeGreaterThan(refreshDirectory);
    expect(deviceLinkHost).toContain(
      'generation !== controllerDisplayNameRefreshGeneration',
    );
    expect(deviceLinkHost).toContain(
      'const directoryRequestSequence = beginControllerDisplayNameDirectoryRefresh();',
    );
    expect(deviceLinkHost).toContain(
      '!isLatestControllerDisplayNameDirectoryRefresh(directoryRequestSequence)',
    );
    expect(deviceLinkHost).toContain(
      'latestControllerDisplayNameDirectoryRefresh = {',
    );
    expect(deviceLinkHost).toContain(
      'const requestEpoch = controllerDisplayNameFreshness.epoch;',
    );
    expect(deviceLinkHost).toContain(
      'applyControllerDisplayNamePresence({',
    );
    expect(deviceLinkHost).toContain(
      "Object.prototype.hasOwnProperty.call(snap, 'selfName')",
    );
    expect(deviceLinkHost).toContain('applyControllerDisplayNameDirectorySnapshot({');
  });

  it('presence 展示名统一走协调器，无有效权威名时保留 dispatch 回退链', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8')
      .replace(/\r\n/g, '\n');

    const presenceHandler = deviceLinkHost.indexOf('client.onPresenceChanged');
    const applyPresenceName = deviceLinkHost.indexOf(
      'applyControllerDisplayNamePresence({',
      presenceHandler,
    );
    expect(presenceHandler).toBeGreaterThanOrEqual(0);
    expect(applyPresenceName).toBeGreaterThan(presenceHandler);

    // guard 不写缓存时，dispatch 继续按「数据库名 → 自报名 → 短 ID」回退。
    expect(dispatch).toContain(
      'return controllerDisplayNameByDevice.get(deviceId)\n    ?? normalizedReportedName\n    ?? reportedControllerNameByDevice.get(deviceId);',
    );
    expect(dispatch).toContain(
      'const displayName = normalized\n    ?? reportedControllerNameByDevice.get(deviceId)\n    ?? deviceId.slice(0, 8);',
    );
  });

  it('keeps device-link:voice:credential-sync matched but rejected (feature removed, readable error for old mobile)', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_CREDENTIAL_SYNC_CHANNEL');
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_CREDENTIAL_SYNC_CHANNEL)');
    expect(dispatch).toContain("code: 'VOICE_CREDENTIAL_SYNC_REMOVED'");
    expect(dispatch).not.toContain('syncMobileVoiceCredential');
  });

  it('routes device-link:voice:dictionary-learning to desktop dictionary learning', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_DICTIONARY_LEARNING_CHANNEL');
    expect(dispatch).toContain("import { adviseAndRecordVoiceInputDictionaryLearning } from '../voice-input/index.js';");
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_DICTIONARY_LEARNING_CHANNEL)');
    expect(dispatch).toContain('handleMobileVoiceDictionaryLearning(src, (payload.args ?? [])[0])');
  });
});
