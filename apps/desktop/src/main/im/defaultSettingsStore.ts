/**
 * IM 默认设置的 main 端持久化源。
 *
 * 每个渠道独立保存新会话路由。文件只保存用户 override；系统默认值来自
 * shared/imDefaultSettings。旧版单槽配置会在首次写入新版结构时按渠道复制一次，
 * 既保留用户原选择，又让之后的渠道修改互不影响。
 */

import path from 'node:path';
import { app } from 'electron';

import {
  IM_DEFAULT_SETTINGS,
  type ImDefaultSettingsChannel,
  type ImDefaultSettingsPatch,
  type ImDefaultSettings,
} from '../../shared/imDefaultSettings.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';
import { claimLegacyImPath, ownerScopedImUserDataPath } from './ownerScopedStorage.js';

import { IM_DEFAULT_SETTINGS_DOCUMENT, normalizeSettings, normalizeDocument, mergeSettingsPatch, documentOverrides, settingsCustomizedKeys, cloneSettings, type ImDefaultSettingsDocument } from '@cindy/im-runtime/defaultSettingsDocument';

const log = desktopMakerLogger.child('im-default-settings-store');

function settingsFilePath(): string {
  const scoped = ownerScopedImUserDataPath('im-default-settings.json');
  claimLegacyImPath(path.join(app.getPath('userData'), 'im-default-settings.json'), scoped);
  return scoped;
}

const store = createOverrideSettingsFile<ImDefaultSettingsDocument>({
  filePath: settingsFilePath,
  defaults: IM_DEFAULT_SETTINGS_DOCUMENT,
  normalize: normalizeDocument,
  mergeOverrides: ({ next, defaults }) => documentOverrides(next, defaults),
  log,
  label: 'im-default',
});

export function readImDefaultSettings(channel?: ImDefaultSettingsChannel): ImDefaultSettings {
  const document = store.read();
  return cloneSettings(channel ? document.channels[channel] : document.global);
}

export function readImDefaultSettingsState(
  channel?: ImDefaultSettingsChannel,
): OverrideSettingsState<ImDefaultSettings> {
  const value = readImDefaultSettings(channel);
  const customizedKeys = settingsCustomizedKeys(value, IM_DEFAULT_SETTINGS);
  return {
    value,
    isCustomized: customizedKeys.length > 0,
    defaults: cloneSettings(IM_DEFAULT_SETTINGS),
    customizedKeys,
  };
}

export function writeImDefaultSettingsPatch(
  patch: ImDefaultSettingsPatch,
  channel?: ImDefaultSettingsChannel,
): OverrideSettingsState<ImDefaultSettings> {
  const document = store.read();
  const current = channel ? document.channels[channel] : document.global;
  const next = mergeSettingsPatch(current, patch);
  if (channel) {
    store.writePatch({
      channels: {
        ...document.channels,
        [channel]: next,
      },
    });
  } else {
    store.writePatch({ global: next });
  }
  log.info('im default settings written', { channel: channel ?? 'global', patch });
  return readImDefaultSettingsState(channel);
}

/**
 * 合并后的设置预览(不写盘) —— 保存前比较路由指纹用: 只改权限档等不动路由默认的
 * 保存, 不该被阻塞式回填(PR #5155 review P2)。
 */
export function previewImDefaultSettingsPatch(
  patch: ImDefaultSettingsPatch,
  channel?: ImDefaultSettingsChannel,
): ImDefaultSettings {
  const document = store.read();
  const current = channel ? document.channels[channel] : document.global;
  return mergeSettingsPatch(current, patch);
}

export function resetImDefaultSettings(): ImDefaultSettings {
  return store.reset().global;
}

export function resetImDefaultSettingsGlobal(): OverrideSettingsState<ImDefaultSettings> {
  store.writePatch({ global: cloneSettings(IM_DEFAULT_SETTINGS) });
  log.info('im default settings reset', { channel: 'global' });
  return readImDefaultSettingsState();
}

export function resetImDefaultSettingsChannel(
  channel: ImDefaultSettingsChannel,
): OverrideSettingsState<ImDefaultSettings> {
  const document = store.read();
  store.writePatch({
    channels: {
      ...document.channels,
      [channel]: cloneSettings(IM_DEFAULT_SETTINGS),
    },
  });
  log.info('im default settings reset', { channel });
  return readImDefaultSettingsState(channel);
}

export const __testing = {
  normalize: normalizeSettings,
  normalizeDocument,
};
