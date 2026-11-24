/**
 * 模型组配置的 main 进程事实源。文件：<userData>/model-groups.json，按账号分开。
 * 默认没有任何路线；只保存用户建的内容，全部删光即恢复默认(删除文件)。
 */
import {
  MODEL_GROUPS_DEFAULTS,
  normalizeModelGroupsConfig,
  type ModelGroupsConfig,
} from '../../shared/modelGroups.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedPath } from '../ownerContext.js';

const log = desktopMakerLogger.child('model-groups-store');

const store = createOverrideSettingsFile<ModelGroupsConfig>({
  filePath: () => ownerScopedPath('model-groups.json'),
  defaults: MODEL_GROUPS_DEFAULTS,
  normalize: normalizeModelGroupsConfig,
  mergeOverrides: ({ next }) => (next.routes.length > 0 ? { routes: next.routes } : {}),
  log,
  label: 'model groups',
  maxBytes: 512 * 1024,
  // 名称是用户自己起的，可能含私人信息；日志只记数量。
  logLoadedValue: false,
});

export function readModelGroupsConfig(): ModelGroupsConfig {
  store.invalidateIfChanged();
  return store.read();
}

export function writeModelGroupsConfig(config: ModelGroupsConfig): ModelGroupsConfig {
  store.writePatch(config);
  const saved = store.read();
  log.info('model groups written', { routes: saved.routes.length });
  return saved;
}

