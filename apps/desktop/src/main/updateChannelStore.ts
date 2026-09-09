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
 *   - xd 组织登录后可由 authManager 在「用户没拨过开关」时补一次默认打开;
 *     用户手动关过(enableBeta override 存在)后重启 / 重登都不再打开。
 *
 * 落盘:userData/update-channel-settings.json。用户拨动写 enableBeta;
 * 组织默认写 orgDefaultEnableBeta,两者分开。
 * 默认关闭。manifestService.fetchManifest() 用 resolveUpdateChannel 把本开关与
 * canaryFlagStore.read() 收敛成最终发布通道(优先级 canary > beta > release)。
 */

import { app } from 'electron';
import path from 'node:path';

import { supportsBetaUpdateChannel } from '../shared/updateChannelCapability';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('update-channel-settings');

export interface UpdateChannelSettings {
  enableBeta: boolean;
  /**
   * xd 组织默认打开留下的标记,不是用户拨动。
   * 有效值:用户写过 enableBeta 用用户值,否则看这个标记。
   */
  orgDefaultEnableBeta: boolean;
}

const DEFAULTS: UpdateChannelSettings = {
  enableBeta: false,
  orgDefaultEnableBeta: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'update-channel-settings.json');
}

function normalize(raw: unknown): UpdateChannelSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    // 这里只还原落盘字段。override store 读盘时会把 defaults 和 overrides 先
    // 合并再交给 normalize,enableBeta:false 分不清是默认还是用户关过,有效值
    // 在 resolveEffectiveSettings 里按 customizedKeys 算。
    enableBeta: typeof r.enableBeta === 'boolean' ? r.enableBeta : DEFAULTS.enableBeta,
    orgDefaultEnableBeta: r.orgDefaultEnableBeta === true,
  };
}

export function resolveEffectiveEnableBeta(
  state: OverrideSettingsState<UpdateChannelSettings>,
): boolean {
  return state.customizedKeys.includes('enableBeta')
    ? state.value.enableBeta
    : state.value.orgDefaultEnableBeta;
}

function resolveEffectiveSettings(
  state: OverrideSettingsState<UpdateChannelSettings>,
): UpdateChannelSettings {
  return {
    enableBeta: resolveEffectiveEnableBeta(state),
    orgDefaultEnableBeta: state.value.orgDefaultEnableBeta,
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
  store.invalidateIfChanged();
  return resolveEffectiveSettings(store.readState());
}

export function readUpdateChannelSettingsState(): OverrideSettingsState<UpdateChannelSettings> {
  return store.readState();
}

export async function writeEnableBeta(enableBeta: boolean): Promise<void> {
  // 关 beta 的值等于系统默认 false。若不 preserveDefaults,override 会被删掉,
  // 用户键消失后会被当成未自定义,xd 组织下次登录又会默认打开。
  // 设置页每次拨动都写 enableBeta,与组织默认标记分开。
  // 和 tryEnableUncustomizedBetaAtomic 共用同一把跨进程锁,避免默认写入盖掉用户关闭。
  await store.writePatchAtomic({ enableBeta }, { preserveDefaults: true });
  log.info('beta update channel setting written', { enableBeta });
}

/** 用户是否显式拨过 beta 开关。组织默认写入不算。 */
export function isEnableBetaUserCustomized(): boolean {
  return store.readState().customizedKeys.includes('enableBeta');
}

/**
 * 仅在用户从没拨过这个开关时打开 beta。
 * 写入 orgDefaultEnableBeta,不写 enableBeta,避免把组织默认伪装成用户 override。
 * 用户手动关过(enableBeta 键存在)后必须保持关。
 * 返回是否实际把有效值从关写成开。
 */
/**
 * 跨进程锁内现读再决定是否打开组织默认。
 * probe 前后另一实例可能已经写下用户关闭,不能用过期的 isCustomized 缓存覆盖。
 */
export async function tryEnableUncustomizedBetaAtomic(
  shouldWrite: () => boolean = () => true,
): Promise<boolean> {
  let wrote = false;
  await store.updateAtomic((current) => {
    if (
      !shouldWrite() ||
      current.customizedKeys.includes('enableBeta') ||
      current.value.enableBeta
    ) {
      return {};
    }
    wrote = true;
    return { orgDefaultEnableBeta: true };
  });
  if (wrote) {
    log.info('beta update channel setting written', {
      enableBeta: true,
      source: 'xd-org-default',
    });
  }
  return wrote;
}

export async function resetUpdateChannelSettings(): Promise<UpdateChannelSettings> {
  return store.resetAtomic();
}

/** manifestService 消费的单一读取入口:返回是否启用 beta(设备级)。 */
export function isBetaChannelEnabled(): boolean {
  // Linux 目前仅 x64 发布 beta .deb。能力不支持时忽略落盘值，避免客户端被钉在
  // 不可达渠道；同时保留值，用户回到支持的构建后仍沿用设备级选择。
  if (!supportsBetaUpdateChannel(process.platform, process.arch)) return false;
  return readUpdateChannelSettings().enableBeta;
}

export const __testing = { normalize };
