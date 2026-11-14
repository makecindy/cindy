/**
 * vision-bridge-settings-store —— 视觉桥配置（层 B/A/C 共用）。
 *
 * File: <userData>/vision-bridge-settings.json
 * Shape:
 *   {
 *     "enabled": false,
 *     "targetModels": [],
 *     "primary": { "providerId": "...", "modelId": "..." } | null,
 *     "fallback": { "providerId": "...", "modelId": "..." } | null
 *   }
 *
 * 默认全部关闭 / 空：视觉桥默认不开启，纯文本模型正常流程零干扰（对齐
 * docs/vision-bridge-design.md 六、配置设计）。
 */

// The store itself lives in visionBridgeSettingsStoreCore.ts (shared with the Node Host).
// This module builds the single Desktop instance; its port resolves Electron when called,
// never when this module loads.
import { createVisionBridgeSettingsStore } from './visionBridgeSettingsStoreCore.js';
import { app } from 'electron';

export type { VisionBackendRef, VisionBridgeSettings } from './visionBridgeSettingsStoreCore.js';

const desktopStore = createVisionBridgeSettingsStore({
  app: { getPath: (name) => app.getPath(name) },
});
type Instance = typeof desktopStore;

export const visionBridgePortableSettings = desktopStore.visionBridgePortableSettings;

export function readVisionBridgeSettings(...args: Parameters<Instance['readVisionBridgeSettings']>): ReturnType<Instance['readVisionBridgeSettings']> {
  return desktopStore.readVisionBridgeSettings(...args);
}

export function isTargetModelsCustomized(...args: Parameters<Instance['isTargetModelsCustomized']>): ReturnType<Instance['isTargetModelsCustomized']> {
  return desktopStore.isTargetModelsCustomized(...args);
}

export function readVisionBridgeSettingsState(...args: Parameters<Instance['readVisionBridgeSettingsState']>): ReturnType<Instance['readVisionBridgeSettingsState']> {
  return desktopStore.readVisionBridgeSettingsState(...args);
}

export function writeVisionBridgeSettings(...args: Parameters<Instance['writeVisionBridgeSettings']>): ReturnType<Instance['writeVisionBridgeSettings']> {
  return desktopStore.writeVisionBridgeSettings(...args);
}

export function resetVisionBridgeSettings(...args: Parameters<Instance['resetVisionBridgeSettings']>): ReturnType<Instance['resetVisionBridgeSettings']> {
  return desktopStore.resetVisionBridgeSettings(...args);
}
