/**
 * 模型组配置的 main 进程事实源。文件：<userData>/model-groups.json，按账号分开。
 * 默认没有任何路线；只保存用户建的内容，全部删光即恢复默认(删除文件)。
 * 读取时带上供应商路由(用户建的与同一家自动合成的)及其在每个模型上的展开(sourceRoutes.ts，展开结果不存盘)：
 * 设置页、选择器、伙伴、撞配额换来源等所有读取方看到的是同一份。
 */
import {
  MODEL_GROUPS_DEFAULTS,
  normalizeModelGroupsConfig,
  type ModelGroupsConfig,
} from '../../shared/modelGroups.js';
import { effectiveModelGroupsConfig, type SourceCatalog } from './sourceRoutes.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedPath } from '../ownerContext.js';

const log = desktopMakerLogger.child('model-groups-store');

const store = createOverrideSettingsFile<ModelGroupsConfig>({
  filePath: () => ownerScopedPath('model-groups.json'),
  defaults: MODEL_GROUPS_DEFAULTS,
  normalize: normalizeModelGroupsConfig,
  mergeOverrides: ({ next }) => ({
    ...(next.routes.length > 0 ? { routes: next.routes } : {}),
    ...(next.sourceRoutes?.length ? { sourceRoutes: next.sourceRoutes } : {}),
    ...(next.hiddenAuto?.length ? { hiddenAuto: next.hiddenAuto } : {}),
    ...(next.autoStrategy && Object.keys(next.autoStrategy).length > 0 ? { autoStrategy: next.autoStrategy } : {}),
    ...(next.autoSwitchOff?.length ? { autoSwitchOff: next.autoSwitchOff } : {}),
    ...(next.autoSources && Object.keys(next.autoSources).length > 0 ? { autoSources: next.autoSources } : {}),
  }),
  log,
  label: 'model groups',
  maxBytes: 512 * 1024,
  // 名称是用户自己起的，可能含私人信息；日志只记数量。
  logLoadedValue: false,
});

/** 账号范围：配置文件按账号分开存，它的路径就是账号的标识。 */
const ownerScope = () => ownerScopedPath('model-groups.json');

/** 最近一次读到的供应商目录，按账号记：换账号后不沿用上一个账号的。供应商路由按它合成和展开。 */
let catalog: { scope: string; value: SourceCatalog } | null = null;
let effective: { stored: ModelGroupsConfig; catalog: SourceCatalog | null; config: ModelGroupsConfig } | null = null;


/** 供应商目录读出来后由读取方(设置页／选择器取配置、解析路由)交进来。 */
export function setModelGroupSourceCatalog(value: SourceCatalog): void {
  catalog = { scope: ownerScope(), value };
}

function readStored(): ModelGroupsConfig {
  store.invalidateIfChanged();
  return store.read();
}

export function readModelGroupsConfig(): ModelGroupsConfig {
  const stored = readStored();
  const current = catalog?.scope === ownerScope() ? catalog.value : null;
  // 同一份存盘配置、同一份目录只展开一次：伙伴、任务绑定等同步读取方会频繁读。
  if (effective?.stored !== stored || effective.catalog !== current) {
    effective = { stored, catalog: current, config: effectiveModelGroupsConfig(stored, current) };
  }
  return effective.config;
}

/**
 * 只存用户建的内容：自己排的路由、自己建的供应商路由、隐藏了哪些自动供应商路由、给它们改的选法。
 * `keep` 里列的字段这次写入没带(只改路由的界面、旧界面)，沿用已存的。
 */
export function writeModelGroupsConfig(
  config: ModelGroupsConfig,
  keep: readonly ('sourceRoutes' | 'hiddenAuto' | 'autoStrategy' | 'autoSwitchOff' | 'autoSources' | 'autoExceptions')[] = [],
): ModelGroupsConfig {
  const before = readStored();
  const pick = <K extends 'sourceRoutes' | 'hiddenAuto' | 'autoStrategy' | 'autoSwitchOff' | 'autoSources' | 'autoExceptions'>(key: K) => (keep.includes(key) ? before[key] : config[key]);
  store.writePatch({
    routes: config.routes.filter((route) => !route.parent),
    sourceRoutes: (pick('sourceRoutes') ?? []).filter((route) => !route.auto),
    hiddenAuto: pick('hiddenAuto') ?? [],
    autoStrategy: pick('autoStrategy') ?? {},
    autoSwitchOff: pick('autoSwitchOff') ?? [],
    autoSources: pick('autoSources') ?? {},
    autoExceptions: pick('autoExceptions') ?? {},
  });
  const saved = readModelGroupsConfig();
  log.info('model groups written', { routes: saved.routes.filter((route) => !route.parent).length, sourceRoutes: saved.sourceRoutes?.length ?? 0 });
  return saved;
}
