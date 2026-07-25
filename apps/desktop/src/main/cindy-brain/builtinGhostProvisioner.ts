import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  GHOST_MANIFEST_FILE,
  ghostIconMimeType,
  validateGhostManifest,
  type GhostManifest,
} from '../../shared/ghost.js';
import { validateGhostLocaleResourcesInDirectory } from './ghostLocaleFiles.js';

/**
 * builtinGhostProvisioner — 内置意识的启动播种(第一方可信通道)。
 *
 * 模型(2026-07-12 Lizi 定案;2026-07-22 种子源拆分为多仓):
 * - 种子 = 随包分发的意识源码目录(dev 读仓库 resources/builtin-ghosts,
 *   packaged 读 process.resourcesPath/builtin-ghosts),不经 .cindy zip;
 * - **多种子根**:种子源按归属拆成多个 submodule 仓(official = cindy-official-plugin,
 *   xd = cindy-xd-plugin),每个根自带一份 provisioning.json,配置损坏按根隔离
 *   fail-closed(只跳过该根的种子,不拖累其它根);同 id 撞车取先到的根(warn 留痕);
 * - **半初始化保护**:submodule 未 init 时根目录存在但为空 —— 任一根为空整轮跳过
 *   孤儿回收(空根无法区分"仓里真没有"和"没 checkout",宁可不删),只做装/覆盖;
 * - 「永远以最新包为准」:对每个种子做内容指纹比对(逐字节收敛),本地没装
 *   就装、指纹不同就覆盖 —— 不看 version 字段,dev 改源码重启即生效;
 * - **受众(audience)**:种子根下可选的 provisioning.json 按 id 声明给谁装
 *   ("all" 或按登录身份命中);不在配置里的种子默认人人都装。身份不再命中
 *   时,把"当初由播种装上的"(seeded 台账)回收删除 —— 用户手动装的同 id
 *   意识不动;
 * - 用户自主权两条豁免:`.disabled` 停用标记覆盖时保留(指纹计算也忽略它);
 *   用户卸载过的内置意识记墓碑,播种永远跳过;
 * - 全程静默(main 内完成,不走 renderer 确认弹窗)—— 三方装入通道的
 *   inspect → 确认 → install 流程不受影响。
 *
 * 依赖注入、零 electron(规则 14):seedRootDir / repoRootDir / identity 由
 * index.ts 装配,单测用 os.tmpdir 下的临时目录直接驱动。
 *
 * ⚠️ 保密边界:受众只是"给谁装"的策展,不是保密 —— 种子字节在安装包里人人
 * 可解。内容不能给包外人看的意识必须走服务端清单分发(第二期),别放这里。
 */

/** 墓碑 + seeded 台账的状态文件(点开头 —— GhostManager.list() 天然跳过)。 */
export const PROVISIONING_STATE_FILE = '.builtin-provisioning.json';
/** 受众配置文件(种子根下,可选;缺失 = 全部种子人人都装)。 */
export const PROVISIONING_CONFIG_FILE = 'provisioning.json';

export interface BuiltinProvisionerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** 播种时的登录身份快照(登出 = null;字段来自 authManager 的 User)。 */
export interface ProvisionIdentity {
  userId: string;
  email: string | null;
}

/**
 * 受众规则:'all' = 人人都装(不需要登录);对象形态 = 登录后任一维度命中
 * 即命中(userIds 精确匹配 / emails 大小写不敏感)。将来的企业 key 等新维度
 * 在这里加字段即可(原 roles 维度随产品级 role 退役,2026-07,当时零使用)。
 * 空对象 / 不认识的形态一律不命中(fail-closed,配错了宁可不装,不把定向
 * 意识误发给所有人)。
 */
export type AudienceRule =
  | 'all'
  | {
      userIds?: string[];
      emails?: string[];
    };

/**
 * 种子档位(来源分类,2026-07-15):'builtin' = 官方内置(人人可见的第一方
 * 意识);'enterprise' = 企业意识(面向组织/定向受众发放)。档位由随包的
 * provisioning.json 声明,**不由 ghost.json 自表**——来源分类跟安装通道走,
 * 不给第三方包"自称官方"的口子。缺省 'builtin'。
 * 只影响设置页分组与标签,不改变播种/回收/墓碑等任何行为。
 */
export type GhostSeedTier = 'builtin' | 'enterprise';

/** provisioning.json 单条种子配置(解析后形态)。 */
interface SeedConfigEntry {
  audience: AudienceRule;
  tier: GhostSeedTier;
}

export interface ProvisionDeps {
  /**
   * 种子根目录列表(builtin-ghosts 下的各 submodule 根,如 official / xd)。
   * 根不存在或为空 = 该根无种子(submodule 未初始化的典型形态);全部为空则
   * 静默返回,部分为空只跳过孤儿回收(半初始化保护,见模块头注释)。
   */
  seedRootDirs: string[];
  /** 意识仓库根(userData/cindy-brain)。 */
  repoRootDir: string;
  /** 当前登录身份(登出传 null;缺省 null)。 */
  identity?: ProvisionIdentity | null;
  /** 回收删除某个意识目录之前的钩子(index.ts 用它先熄灯沙箱,防 Windows 文件锁)。 */
  beforeRemove?: (id: string) => void | Promise<void>;
  /**
   * 首次真实变更(装/覆盖/回收)动手前回调,整轮至多一次 —— index.ts 用它
   * 广播"播种进行中"的 UI 提示;指纹全一致的 no-op 轮永不触发(不闪提示)。
   */
  onApplyStart?: () => void;
  log?: BuiltinProvisionerLogger;
}

export interface ProvisionOutcome {
  /** 本次首装的意识(装完默认唤醒;调用方负责停靠面板 + 广播 + 常驻点火)。 */
  installed: GhostManifest[];
  /** 本次覆盖更新的意识(`.disabled` 已保留;调用方负责广播)。 */
  updated: GhostManifest[];
  /** 本次因受众不再命中而回收删除的 id(调用方负责广播)。 */
  removed: string[];
  /** 指纹一致 / 墓碑 / 受众不命中 / 种子不合格而跳过的 id(仅日志用途)。 */
  skipped: string[];
}

/** 播种状态文件形态(墓碑 + seeded 台账;将来组织清单等扩展也落这里)。 */
interface ProvisioningState {
  /** 用户主动卸载过的内置意识 id —— 播种永远跳过,除非用户手动重装(清墓碑)。 */
  removed: string[];
  /** 由播种装上的 id 台账 —— 受众不再命中时只回收台账内的,用户手动装的不动。 */
  seeded: string[];
}

/** 列出多个种子根下的意识 id 并集(去重排序)。根缺失/为空按无种子处理。 */
export function listBuiltinSeedIds(seedRootDirs: string[]): string[] {
  const ids = new Set<string>();
  for (const root of seedRootDirs) {
    for (const id of listSeedIdsInRoot(root)) ids.add(id);
  }
  return [...ids].sort();
}

/** 列出单个种子根下的意识 id(= 子目录名;点开头跳过)。种子根缺失返回空。 */
function listSeedIdsInRoot(seedRootDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(seedRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** 读墓碑列表(状态文件缺失 / 损坏一律当空,不阻断播种)。 */
export function readBuiltinTombstones(repoRootDir: string): string[] {
  return readState(repoRootDir).removed;
}

/** 记墓碑(幂等)。用户卸载内置意识时由 IPC 层调用;同时从 seeded 台账摘除。 */
export function recordBuiltinTombstone(repoRootDir: string, id: string, log?: BuiltinProvisionerLogger): void {
  const state = readState(repoRootDir);
  if (state.removed.includes(id) && !state.seeded.includes(id)) return;
  writeState(
    repoRootDir,
    {
      removed: state.removed.includes(id) ? state.removed : [...state.removed, id],
      seeded: state.seeded.filter((v) => v !== id),
    },
    log,
  );
}

/** 清墓碑(幂等)。用户手动重装同 id 意识 = 重新跟随包内版本。 */
export function clearBuiltinTombstone(repoRootDir: string, id: string, log?: BuiltinProvisionerLogger): void {
  const state = readState(repoRootDir);
  if (!state.removed.includes(id)) return;
  writeState(repoRootDir, { ...state, removed: state.removed.filter((v) => v !== id) }, log);
}

function readState(repoRootDir: string): ProvisioningState {
  const empty: ProvisioningState = { removed: [], seeded: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRootDir, PROVISIONING_STATE_FILE), 'utf-8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return empty;
    const obj = raw as { removed?: unknown; seeded?: unknown };
    return {
      removed: Array.isArray(obj.removed) ? obj.removed.filter((v): v is string => typeof v === 'string') : [],
      seeded: Array.isArray(obj.seeded) ? obj.seeded.filter((v): v is string => typeof v === 'string') : [],
    };
  } catch {
    return empty;
  }
}

function writeState(repoRootDir: string, state: ProvisioningState, log?: BuiltinProvisionerLogger): void {
  try {
    fs.mkdirSync(repoRootDir, { recursive: true });
    fs.writeFileSync(path.join(repoRootDir, PROVISIONING_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    // 状态写失败不致命(最坏情况:卸载的内置意识下次启动弹回来一次),warn 留痕。
    log?.warn('builtin provisioning state write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 受众命中判定(纯函数,fail-closed:不认识的规则形态一律不命中)。 */
export function matchesAudience(rule: AudienceRule | undefined, identity: ProvisionIdentity | null): boolean {
  if (rule === undefined || rule === 'all') return true;
  if (typeof rule !== 'object' || rule === null) return false;
  if (identity === null) return false;
  if (Array.isArray(rule.userIds) && rule.userIds.includes(identity.userId)) return true;
  if (Array.isArray(rule.emails) && identity.email !== null) {
    const emailFold = identity.email.toLowerCase();
    if (rule.emails.some((e) => typeof e === 'string' && e.toLowerCase() === emailFold)) return true;
  }
  return false;
}

/**
 * 读受众配置。三种结果:
 * - 文件不存在 → 空表(全部种子默认 'all',零配置模式);
 * - 文件在且合法 → id → 规则表;
 * - 文件在但坏(JSON 解析失败 / 形态不对)→ null(fail-closed:本根种子整轮
 *   跳过,warn 留痕 —— 配置坏了宁可什么都不动,不按"人人都装"误发定向意识)。
 */
function readProvisioningConfig(
  seedRootDir: string,
  log?: BuiltinProvisionerLogger,
): Map<string, SeedConfigEntry> | null {
  const file = path.join(seedRootDir, PROVISIONING_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    log?.warn('builtin provisioning config unreadable', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) throw new Error('config root must be an object');
    const ghosts = (raw as { ghosts?: unknown }).ghosts;
    if (ghosts === undefined) return new Map();
    if (typeof ghosts !== 'object' || ghosts === null) throw new Error('"ghosts" must be an object');
    const map = new Map<string, SeedConfigEntry>();
    for (const [id, entry] of Object.entries(ghosts as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) throw new Error(`ghosts["${id}"] must be an object`);
      const audience = (entry as { audience?: unknown }).audience;
      const tier = (entry as { tier?: unknown }).tier;
      // tier 只认 'builtin' / 'enterprise'(缺省 builtin);写错整份配置按损坏
      // 处理(与 audience 同一 fail-closed 口径,配错宁可本轮不动)。
      if (tier !== undefined && tier !== 'builtin' && tier !== 'enterprise') {
        throw new Error(`ghosts["${id}"].tier must be 'builtin' or 'enterprise'`);
      }
      map.set(id, {
        // audience 缺省 = 'all';其余形态原样进 matchesAudience(fail-closed 在那边)。
        audience: audience === undefined ? 'all' : (audience as AudienceRule),
        tier: tier === 'enterprise' ? 'enterprise' : 'builtin',
      });
    }
    return map;
  } catch (err) {
    log?.warn('builtin provisioning config invalid, skipping this seed root this round', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 播种主流程。对每个种子:墓碑 → 受众 → 指纹 → 首装 / 覆盖 / 回收 / 跳过。
 * 单个种子失败只 warn + 跳过,绝不拖垮其它种子或启动流程。
 * 多根语义:配置损坏按根 fail-closed(该根种子整轮跳过,但其 id 仍算入种子
 * 全集,不会被当孤儿回收);同 id 撞车取先到的根;任一根为空跳过孤儿回收。
 */
export async function provisionBuiltinGhosts(deps: ProvisionDeps): Promise<ProvisionOutcome> {
  const { seedRootDirs, repoRootDir, log } = deps;
  const identity = deps.identity ?? null;
  const outcome: ProvisionOutcome = { installed: [], updated: [], removed: [], skipped: [] };

  // 每根独立列种子 + 读配置。空根不读配置(未初始化 submodule 的目录里连
  // provisioning.json 都没有,读了必 warn,徒增噪音)。
  const rootStates = seedRootDirs.map((root) => {
    const ids = listSeedIdsInRoot(root);
    return {
      root,
      ids,
      config: ids.length === 0 ? new Map<string, SeedConfigEntry>() : readProvisioningConfig(root, log),
    };
  });
  const allSeedIds = new Set(rootStates.flatMap((s) => s.ids));
  if (allSeedIds.size === 0) return outcome;
  const hasEmptyRoot = rootStates.some((s) => s.ids.length === 0);

  const state = readState(repoRootDir);
  const tombstones = new Set(state.removed);
  const seeded = new Set(state.seeded);
  const seededBefore = new Set(seeded);

  let applyStarted = false;
  const markApplyStart = (): void => {
    if (applyStarted) return;
    applyStarted = true;
    deps.onApplyStart?.();
  };

  const processed = new Set<string>();
  for (const { root, ids, config } of rootStates) {
    if (config === null) {
      // 本根配置损坏:fail-closed 跳过本根全部种子;id 仍在 allSeedIds 里,
      // 孤儿回收不会误删它们名下已装的意识。
      outcome.skipped.push(...ids);
      continue;
    }
    for (const id of ids) {
      if (processed.has(id)) {
        log?.warn('builtin seed skipped: duplicate id across seed roots', { id, root });
        outcome.skipped.push(id);
        continue;
      }
      processed.add(id);
      const seedDir = path.join(root, id);
      try {
        // 1) 种子自检:manifest 合法且 id 与目录名一致(第一方内容,不合格
        //    属于打包/提交事故 —— warn 跳过,别把坏种子播出去)。
        const manifest = readSeedManifest(seedDir, id, log);
        if (!manifest) {
          outcome.skipped.push(id);
          continue;
        }

        // 2) 墓碑:用户删过,永不装回(顺手清掉台账残留)。
        if (tombstones.has(id)) {
          seeded.delete(id);
          outcome.skipped.push(id);
          continue;
        }

        const installedDir = path.join(repoRootDir, id);
        const installedExists = fs.existsSync(path.join(installedDir, GHOST_MANIFEST_FILE));

        // 3) 受众:不命中 → 回收"播种装的"(seeded 台账内),手动装的不动。
        if (!matchesAudience(config.get(id)?.audience, identity)) {
          if (seeded.has(id) && installedExists) {
            markApplyStart();
            await deps.beforeRemove?.(id);
            await fs.promises.rm(installedDir, { recursive: true, force: true });
            seeded.delete(id);
            outcome.removed.push(id);
            log?.info('builtin ghost removed: audience no longer matches', { id });
          } else {
            outcome.skipped.push(id);
          }
          continue;
        }

        // 4) 指纹比对(忽略点开头文件:`.disabled` 是用户状态不是内容)。
        if (installedExists) {
          const seedHash = await hashDirContent(seedDir);
          const installedHash = await hashDirContent(installedDir);
          if (seedHash === installedHash) {
            outcome.skipped.push(id);
            continue;
          }
          const wasDisabled = fs.existsSync(path.join(installedDir, '.disabled'));
          markApplyStart();
          await swapInSeed(seedDir, installedDir, repoRootDir, id, { disabled: wasDisabled });
          seeded.add(id);
          outcome.updated.push(manifest);
          log?.info('builtin ghost updated to bundled content', { id, version: manifest.version });
        } else {
          markApplyStart();
          await swapInSeed(seedDir, installedDir, repoRootDir, id, { disabled: false });
          seeded.add(id);
          outcome.installed.push(manifest);
          log?.info('builtin ghost installed', { id, version: manifest.version });
        }
      } catch (err) {
        outcome.skipped.push(id);
        log?.warn('builtin ghost provisioning failed', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 孤儿种子回收(2026-07-13,filo-google 更名实撞):种子目录从包里消失
  // (意识改名 / 下架)时,当初"播种装上的"旧包也要收走,否则新旧两个
  // 意识并存(工具面重复、旧包永不再更新)。只收 seeded 台账内的——用户
  // 手动装的同 id 意识与本机制无关,照旧不动。
  // 半初始化保护(多根拆分后新增):任一根为空说明该根 submodule 很可能没
  // checkout,其种子全集不可知 —— 本轮跳过孤儿回收,宁可留旧包也不误删。
  if (hasEmptyRoot) {
    log?.info('builtin ghost orphan recovery skipped: empty seed root (submodule not initialized?)', {
      emptyRoots: rootStates.filter((s) => s.ids.length === 0).map((s) => s.root),
    });
  } else {
    for (const id of [...seeded]) {
      if (allSeedIds.has(id)) continue;
      const installedDir = path.join(repoRootDir, id);
      if (fs.existsSync(path.join(installedDir, GHOST_MANIFEST_FILE))) {
        try {
          markApplyStart();
          await deps.beforeRemove?.(id);
          await fs.promises.rm(installedDir, { recursive: true, force: true });
          outcome.removed.push(id);
          log?.info('builtin ghost removed: seed no longer bundled', { id });
        } catch (err) {
          log?.warn('builtin ghost orphan removal failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue; // 删失败保留台账,下轮再试
        }
      }
      seeded.delete(id);
    }
  }

  if (!setsEqual(seeded, seededBefore)) {
    writeState(repoRootDir, { removed: [...tombstones], seeded: [...seeded].sort() }, log);
  }
  return outcome;
}

/** 「已抽离、可一键恢复」的内置意识摘要(设置页灰态占位行的数据源)。 */
export interface RestorableBuiltinGhost {
  id: string;
  name: string;
  description?: string;
  version: string;
  /** 随包 seed 的完整已校验身份卡;卸载不抹掉插件的声明事实。 */
  manifest: GhostManifest;
  /** 种子档位(设置页按它归组:builtin → 内置组,enterprise → 企业组)。 */
  tier: GhostSeedTier;
  iconDataUrl?: string;
}

/** 恢复行 icon 上限(与 GhostManager 的装载口径一致)。 */
const MAX_RESTORABLE_ICON_BYTES = 512 * 1024;

/**
 * 列出"可恢复"的内置意识 = 种子 ∩ 墓碑 ∩ 受众命中。
 * 全同步(设置页 sendSync 首帧拉取,种子极小);受众不命中的墓碑不列
 * (恢复了也装不上);配置损坏按根 fail-closed(只该根不列,不拖累其它根);
 * 同 id 撞车取先到的根(与播种口径一致)。
 */
export function listRestorableBuiltinGhosts(deps: {
  seedRootDirs: string[];
  repoRootDir: string;
  identity?: ProvisionIdentity | null;
  log?: BuiltinProvisionerLogger;
}): RestorableBuiltinGhost[] {
  const tombstones = new Set(readBuiltinTombstones(deps.repoRootDir));
  if (tombstones.size === 0) return [];
  const identity = deps.identity ?? null;

  const result: RestorableBuiltinGhost[] = [];
  const seen = new Set<string>();
  for (const root of deps.seedRootDirs) {
    const ids = listSeedIdsInRoot(root);
    if (ids.length === 0) continue;
    const config = readProvisioningConfig(root, deps.log);
    if (config === null) continue;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!tombstones.has(id)) continue;
      if (!matchesAudience(config.get(id)?.audience, identity)) continue;
      const seedDir = path.join(root, id);
      const manifest = readSeedManifest(seedDir, id, deps.log);
      if (!manifest) continue;
      const iconDataUrl = readSeedIconDataUrl(seedDir, manifest);
      result.push({
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        version: manifest.version,
        manifest,
        tier: config.get(id)?.tier ?? 'builtin',
        ...(iconDataUrl !== null ? { iconDataUrl } : {}),
      });
    }
  }
  return result;
}

/**
 * 列出企业档种子 id(= 种子目录 ∩ provisioning.json 里 tier: 'enterprise')。
 * 纯展示用途(设置页分组/打标),配置缺失或损坏按根降级成"全归内置组"
 * 而不是报错,不影响播种主流程。
 */
export function listEnterpriseSeedIds(seedRootDirs: string[], log?: BuiltinProvisionerLogger): string[] {
  const ids = new Set<string>();
  for (const root of seedRootDirs) {
    const rootIds = listSeedIdsInRoot(root);
    if (rootIds.length === 0) continue;
    const config = readProvisioningConfig(root, log);
    if (config === null) continue;
    for (const id of rootIds) {
      if (config.get(id)?.tier === 'enterprise') ids.add(id);
    }
  }
  return [...ids].sort();
}

/** 种子目录里的 icon → data URL(缺失/超限/读失败降级 null,不拖垮列表)。 */
function readSeedIconDataUrl(seedDir: string, manifest: GhostManifest): string | null {
  if (manifest.icon === undefined) return null;
  try {
    const iconPath = path.join(seedDir, ...manifest.icon.split('/'));
    const stat = fs.statSync(iconPath);
    if (!stat.isFile() || stat.size > MAX_RESTORABLE_ICON_BYTES) return null;
    const mime = ghostIconMimeType(manifest.icon);
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(iconPath).toString('base64')}`;
  } catch {
    return null;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** 读并校验种子 manifest;不合格返回 null(warn 留痕)。 */
function readSeedManifest(seedDir: string, id: string, log?: BuiltinProvisionerLogger): GhostManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(seedDir, GHOST_MANIFEST_FILE), 'utf-8'));
  } catch (err) {
    log?.warn('builtin seed skipped: unreadable manifest', {
      seedDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const v = validateGhostManifest(raw);
  if (!v.ok) {
    log?.warn('builtin seed skipped: invalid manifest', { seedDir, reason: v.reason });
    return null;
  }
  if (v.manifest.id !== id) {
    log?.warn('builtin seed skipped: dir name != manifest id', { seedDir, manifestId: v.manifest.id });
    return null;
  }
  const localeValidation = validateGhostLocaleResourcesInDirectory(seedDir, v.manifest);
  if (!localeValidation.ok) {
    log?.warn('builtin seed skipped: invalid locale resources', {
      seedDir,
      reason: localeValidation.reason,
    });
    return null;
  }
  return v.manifest;
}

/**
 * 目录内容指纹:相对路径排序后逐个 hash(路径 + 字节),点开头条目跳过。
 * 意识包极小(zip 通道上限才 8MB),启动算一遍开销可忽略。
 */
export async function hashDirContent(dir: string): Promise<string> {
  const files = collectFiles(dir, '');
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.promises.readFile(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 递归收集相对文件路径(正斜杠归一化保证双平台指纹一致;点开头跳过)。 */
function collectFiles(rootDir: string, relBase: string): string[] {
  const abs = path.join(rootDir, relBase);
  const result: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = relBase.length === 0 ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(...collectFiles(rootDir, rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
  }
  return result;
}

/**
 * 种子落位:复制到 staging → (可选)写 `.disabled` → 换目录。
 * 换目录用与 GhostManager.update 相同的备份滚回模式:任何时刻磁盘上都有
 * 一份完整版本,失败不会留半截。
 */
async function swapInSeed(
  seedDir: string,
  finalDir: string,
  repoRootDir: string,
  id: string,
  opts: { disabled: boolean },
): Promise<void> {
  const rand = crypto.randomBytes(4).toString('hex');
  const stagingDir = path.join(repoRootDir, `.cindy-provisioning-${id}-${rand}`);
  const backupDir = path.join(repoRootDir, `.cindy-provisioning-bak-${id}-${rand}`);

  try {
    await copyDirSkippingDotEntries(seedDir, stagingDir);
    if (opts.disabled) {
      await fs.promises.writeFile(path.join(stagingDir, '.disabled'), '');
    }
  } catch (err) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const hadExisting = fs.existsSync(finalDir);
  if (hadExisting) {
    await fs.promises.rename(finalDir, backupDir);
  }
  try {
    await fs.promises.rename(stagingDir, finalDir);
  } catch (err) {
    if (hadExisting) await fs.promises.rename(backupDir, finalDir).catch(() => {});
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (hadExisting) {
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 递归复制目录,点开头条目跳过(种子里的 .DS_Store 等垃圾不落仓库)。 */
async function copyDirSkippingDotEntries(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirSkippingDotEntries(src, dest);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(src, dest);
    }
  }
}
