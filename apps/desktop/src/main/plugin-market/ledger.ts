import crypto from 'node:crypto';
import path from 'node:path';

import type { PluginScope } from '@cindy/plugin-protocol';
import {
  atomicWriteFileSync,
  readAtomicFileSync,
} from '../utils/atomicWriteFile.js';

const LEDGER_SCHEMA_VERSION = 1;

/** 自定义市场溯源的独立账本文件名（与 ledger.v1.json 同目录）。 */
const CUSTOM_LEDGER_FILE = 'custom-ledger.v1.json';

/** 服务端市场安装的溯源来源（旧版本也认识的封闭集合）。 */
const SERVER_SOURCES = new Set(['market', 'legacy-adopted']);

export interface PluginMarketInstallationRecord {
  pluginId: string;
  ghostId: string;
  releaseId: string;
  version: string;
  sha256: string;
  scope: PluginScope;
  organizationId: string | null;
  source: 'market' | 'legacy-adopted' | 'git-market' | 'local-market';
  installed: boolean;
  updatedAt: string;
  /**
   * 自定义来源的规范化指纹（marketSourceKey）。市场名可复用——移除来源后添加
   * 同名异源的市场会得到相同 pluginId,所有权校验必须同时对上这个指纹。
   * 仅自定义安装记录携带;服务端记录没有此字段。
   */
  sourceKey?: string;
  /**
   * 安装落位那一刻的 manifest 规范化摘要（ghostManifestDigest）。账本记录只是
   * "我装过"的声明,运行时的包在降级窗口可以被旧版换成任何东西(旧版不认识
   * custom 账本,卸载/本地重装都不会更新它)——认领运行时安装必须同时对上这个
   * 摘要,只凭 ghostId 存在就恢复所有权会把别人的包错误归属给本来源并放行其
   * 更新覆盖。新写入的市场、自定义市场和 legacy adoption 记录均应携带。
   */
  manifestDigest?: string;
}

/** 递归按键排序的规范化 JSON(摘要必须与对象键序无关,两侧独立算也一致)。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** manifest 的稳定摘要:语义相同的 manifest 无论键序/来源如何,摘要一致。 */
export function ghostManifestDigest(manifest: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

interface PluginMarketLedgerData {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  installations: Record<string, PluginMarketInstallationRecord>;
  defaultInstallOptOuts: Record<string, string[]>;
}

function emptyLedger(): PluginMarketLedgerData {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    installations: {},
    defaultInstallOptOuts: {},
  };
}

function isCustomRecord(record: PluginMarketInstallationRecord): boolean {
  return record.source === 'git-market' || record.source === 'local-market';
}

/**
 * 同一 ghostId 在两个账本文件里都有记录时的消解规则(只在降级窗口出现):
 * 仍在安装中的记录优先于已卸载的;同为安装中(或同为已卸载)按 updatedAt 新者
 * 胜(ISO 字符串可直接比较);完全平手保第一个参数(调用方传主账本记录——冲突
 * 本身即意味着旧版本操作过主账本,它是最后被真实写入过的一侧)。
 */
function preferRecord(
  main: PluginMarketInstallationRecord,
  custom: PluginMarketInstallationRecord,
): PluginMarketInstallationRecord {
  if (main.installed !== custom.installed) return main.installed ? main : custom;
  return custom.updatedAt > main.updatedAt ? custom : main;
}

function validRecord(value: unknown): value is PluginMarketInstallationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pluginId === 'string' &&
    typeof record.ghostId === 'string' &&
    typeof record.releaseId === 'string' &&
    typeof record.version === 'string' &&
    typeof record.sha256 === 'string' &&
    (record.scope === 'public' ||
      record.scope === 'organization' ||
      record.scope === 'personal') &&
    (record.organizationId === null || typeof record.organizationId === 'string') &&
    (record.source === 'market' ||
      record.source === 'legacy-adopted' ||
      record.source === 'git-market' ||
      record.source === 'local-market') &&
    typeof record.installed === 'boolean' &&
    typeof record.updatedAt === 'string' &&
    (record.sourceKey === undefined || typeof record.sourceKey === 'string') &&
    (record.manifestDigest === undefined || typeof record.manifestDigest === 'string')
  );
}

/** 读取并解析一个账本 JSON 文件的 installations 段;文件不存在返回空。 */
function readInstallationsFile(
  filePath: string,
): { installations: Record<string, PluginMarketInstallationRecord>; raw: Record<string, unknown> | null } {
  // 读失败与解析失败分开处理:文件不存在(ENOENT)才是空;文件在但读不到(文件锁/
  // 权限/瞬时 I/O)或备份救不回来时由 readAtomicFileSync **上抛**——降级成空会让
  // 紧接着的写入把真实记录覆盖掉。只有"内容确实不是合法 JSON"才按空重建。
  const text = readAtomicFileSync(filePath);
  if (text === null) return { installations: {}, raw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { installations: {}, raw: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { installations: {}, raw: null };
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== LEDGER_SCHEMA_VERSION) return { installations: {}, raw: null };
  const installations: Record<string, PluginMarketInstallationRecord> = {};
  if (value.installations && typeof value.installations === 'object') {
    for (const [ghostId, record] of Object.entries(value.installations)) {
      if (validRecord(record) && record.ghostId === ghostId) installations[ghostId] = record;
    }
  }
  return { installations, raw: value };
}

/**
 * Plugin 市场来源账本。包目录仍是 runtime 安装事实；本账本只记录 server
 * Plugin ID、Release 溯源和 defaultInstall 退订，不复制 manifest/凭证。
 *
 * **存储分两个文件（存量兼容红线）**：
 * - `ledger.v1.json`:服务端安装（market / legacy-adopted）与 defaultInstall 退订。
 *   schema 与旧版本完全一致——旧版 `validRecord()` 是封闭枚举,任何它不认识的
 *   source 都会在下一次写入时被过滤并重写落盘。
 * - `custom-ledger.v1.json`:自定义市场安装（git-market / local-market）。旧版本
 *   不认识也不会触碰这个文件,用户降级再升级,自定义安装的溯源原样还在。
 * 若把自定义记录混进主账本,降级后旧版的任意一次写入都会把它们永久丢掉,该插件
 * 再升级后会被投影成"占用 ghostId 的本地冲突项"、无法从原市场更新。
 *
 * 早期开发版把自定义记录写进了主账本:读取时兼容合并,任意一次写入即按 source
 * 归位迁移（写路径本来就整份重写两个文件）。
 */
export class PluginMarketLedger {
  constructor(private readonly filePathSource: string | (() => string)) {}

  /**
   * Binds a dynamic owner-scoped ledger to the path captured at operation start.
   * Static test/isolated ledgers keep their instance so callers can inspect them.
   */
  bind(filePath: string): PluginMarketLedger {
    return typeof this.filePathSource === 'function'
      ? new PluginMarketLedger(filePath)
      : this;
  }

  private filePath(): string {
    return typeof this.filePathSource === 'function'
      ? this.filePathSource()
      : this.filePathSource;
  }

  /** 自定义溯源账本与主账本同目录（同一 owner 作用域）。 */
  private customFilePath(): string {
    return path.join(path.dirname(this.filePath()), CUSTOM_LEDGER_FILE);
  }

  read(): PluginMarketLedgerData {
    const main = readInstallationsFile(this.filePath());
    const custom = readInstallationsFile(this.customFilePath());

    const installations: Record<string, PluginMarketInstallationRecord> = {};
    for (const [ghostId, record] of Object.entries(main.installations)) {
      // 主账本里的自定义记录是早期开发版写入的存量,一并纳入(下次写入时归位)。
      installations[ghostId] = record;
    }
    for (const [ghostId, record] of Object.entries(custom.installations)) {
      if (!isCustomRecord(record)) continue; // 自定义账本只承载自定义溯源
      // 两个文件出现同一 ghostId 只发生在降级窗口:旧版本只写主账本(比如降级后
      // 卸载了自定义安装、又从服务端装了同 ghostId),custom 账本里留着它不认识、
      // 也不会清理的陈旧记录。无条件让 custom 覆盖会把服务端安装错误归属给自定义
      // 来源,并允许该来源提供更新 —— 必须按"实际安装状态 + 时间"消解,平手保
      // 主账本(冲突本身即意味着旧版操作过主账本)。胜出后由任意一次写入按 source
      // 归位,败方记录随整份重写被清掉。
      const existing = installations[ghostId];
      installations[ghostId] = existing ? preferRecord(existing, record) : record;
    }

    const defaultInstallOptOuts: Record<string, string[]> = {};
    const rawOptOuts = main.raw?.defaultInstallOptOuts;
    if (rawOptOuts && typeof rawOptOuts === 'object') {
      for (const [userId, pluginIds] of Object.entries(rawOptOuts)) {
        if (!Array.isArray(pluginIds)) continue;
        defaultInstallOptOuts[userId] = [
          ...new Set(pluginIds.filter((id): id is string => typeof id === 'string')),
        ];
      }
    }
    return { schemaVersion: LEDGER_SCHEMA_VERSION, installations, defaultInstallOptOuts };
  }

  installationForGhost(ghostId: string): PluginMarketInstallationRecord | null {
    return this.read().installations[ghostId] ?? null;
  }

  upsertInstallation(record: PluginMarketInstallationRecord): void {
    const data = this.read();
    data.installations[record.ghostId] = record;
    this.write(data);
  }

  markRemoved(ghostId: string, userId: string | null): void {
    const data = this.read();
    const record = data.installations[ghostId];
    if (!record) return;
    data.installations[ghostId] = {
      ...record,
      installed: false,
      updatedAt: new Date().toISOString(),
    };
    if (userId) {
      data.defaultInstallOptOuts[userId] = [
        ...new Set([...(data.defaultInstallOptOuts[userId] ?? []), record.pluginId]),
      ];
    }
    this.write(data);
  }

  isDefaultInstallSuppressed(userId: string, pluginId: string): boolean {
    return this.read().defaultInstallOptOuts[userId]?.includes(pluginId) ?? false;
  }

  private write(data: PluginMarketLedgerData): void {
    // 按 source 分仓落盘:主账本只出现旧版本认识的 source,自定义溯源全部进
    // 独立文件。混写过的存量(早期开发版)由此在任意一次写入时自动归位。
    const server: Record<string, PluginMarketInstallationRecord> = {};
    const custom: Record<string, PluginMarketInstallationRecord> = {};
    for (const [ghostId, record] of Object.entries(data.installations)) {
      if (isCustomRecord(record)) custom[ghostId] = record;
      else if (SERVER_SOURCES.has(record.source)) server[ghostId] = record;
    }
    atomicWriteFileSync(
      this.filePath(),
      `${JSON.stringify(
        {
          schemaVersion: LEDGER_SCHEMA_VERSION,
          installations: server,
          defaultInstallOptOuts: data.defaultInstallOptOuts,
        },
        null,
        2,
      )}\n`,
    );
    atomicWriteFileSync(
      this.customFilePath(),
      `${JSON.stringify(
        { schemaVersion: LEDGER_SCHEMA_VERSION, installations: custom },
        null,
        2,
      )}\n`,
    );
  }
}
