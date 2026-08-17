/**
 * updateChannelStore.ts
 * ---------------------------------------------------------------------------
 * beta 测试渠道的**设备级**本地开关。
 *
 * 与 canaryFlagStore 的关键区别:
 *   - canary 是**账号级、服务端下发**的灰度标记(feature-flags → 本地持久化 →
 *     登出清),所以它的 flag 文件随账号生命周期走;
 *   - beta 是**设备级、客户端本地设置**——设置页一个开关,登出/换号都不清。
 *     所以这里用 createOverrideSettingsFile(与 auto-update-settings 同一套
 *     override 语义:默认值 + 用户 override、恢复默认只删 override),而不是仿
 *     canaryFlagStore 的裸 JSON。
 *
 * 落盘:userData/update-channel-settings.json,字段 { enableBeta: boolean }。
 * 默认关闭。manifestService.fetchManifest() 用 resolveUpdateChannel 把本开关与
 * canaryFlagStore.read() 收敛成最终发布通道(优先级 canary > beta > release)。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('update-channel-settings');

export interface UpdateChannelSettings {
  enableBeta: boolean;
}

const DEFAULTS: UpdateChannelSettings = {
  enableBeta: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'update-channel-settings.json');
}

function normalize(raw: unknown): UpdateChannelSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enableBeta:
      typeof r.enableBeta === 'boolean' ? r.enableBeta : DEFAULTS.enableBeta,
  };
}

const store = createOverrideSettingsFile<UpdateChannelSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'update-channel',
});

export function readUpdateChannelSettings(): UpdateChannelSettings {
  return store.read();
}

export function readUpdateChannelSettingsState(): OverrideSettingsState<UpdateChannelSettings> {
  return store.readState();
}

export function writeEnableBeta(enableBeta: boolean): void {
  store.writePatch({ enableBeta });
  log.info('beta update channel setting written', { enableBeta });
}

export function resetUpdateChannelSettings(): UpdateChannelSettings {
  return store.reset();
}

/** manifestService 消费的单一读取入口:返回是否启用 beta(设备级)。 */
export function isBetaChannelEnabled(): boolean {
  return readUpdateChannelSettings().enableBeta;
}

export const __testing = { normalize };
