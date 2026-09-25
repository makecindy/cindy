/**
 * ghostKvStore —— 意识自定义参数的持久化真身(/kv 协议端点的存储层)。
 *
 * File: <rootDir>/<storagePart>.json(生产 rootDir = <userData>/ghost-kv/;
 *   root = helper.json, org = _ns__acme__helper.json)
 *
 * 语义(docs/dev-rules/plugin-security-and-authoring.md / FORGE_GUIDE §4.8):
 * - 单意识单文件:损坏只伤一个意识,卸下清理 = unlink 一个文件;
 * - 值必须是 plain JSON object,序列化 ≤ 64KB(GHOST_KV_MAX_BYTES),
 *   整体覆盖写(last-write-wins),不做字段级 merge;
 * - **卸下(uninstall)清除、沉睡(disable)保留**——与凭证保险库同一
 *   卸载点位清理(index.ts ghosts:uninstall);
 * - 读:无文件 / 损坏 JSON / 非对象一律回 {},不抛——存储层损坏不该
 *   炸掉设置页;
 * - 写:tmp + rename 原子落盘(override-settings-file 同款),同步 IO
 *   天然串行,≤64KB 量级无阻塞之虞;
 * - storage part 过 isValidPluginStoragePart 双保险(调用方来自分区绑定,理论上已合法;
 *   文件名安全不省这道)。
 *
 * 与 Electron 解耦:rootDir 经工厂注入,单测直接用 os.tmpdir()(规范 14/23)。
 */

import fs from 'node:fs';
import path from 'node:path';

import { isValidPluginStoragePart } from '../../shared/pluginIdentity.js';

/** 单意识 KV 序列化后的字节上限(64KB;超限写入拒 413)。 */
export const GHOST_KV_MAX_BYTES = 64 * 1024;

/** 最小日志面(避免测试里拖 electron logger)。 */
interface GhostKvLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface GhostKvStore {
  /** 读某意识的 KV;无文件 / 损坏 → {}(永不抛)。 */
  read(ghostId: string): Record<string, unknown>;
  /**
   * 严格读:无文件 → {},但 IO 异常 / JSON 损坏**原样上抛**。setup 就绪
   * 检查(ghosts:setup-status)专用——「查询失败」≠「未配置」,不能拿
   * read 的宽松口径把存储层故障误判成缺配置去拦用户;设置页协议端点
   * 仍走 read(损坏不炸设置页的语义不变)。
   */
  readStrict(ghostId: string): Record<string, unknown>;
  /**
   * 整体覆盖写;值非 plain object 或序列化超限时抛带 code 的错
   * ('INVALID_VALUE' | 'TOO_LARGE' | 'INVALID_GHOST_ID'),由端点层折叠成状态码。
   */
  write(ghostId: string, value: Record<string, unknown>): void;
  /** 删除某意识的 KV 文件;幂等,不存在静默。 */
  remove(ghostId: string): void;
}

/**
 * 卸载目录已经删除后，KV 只是附属清理；文件锁或权限异常只能记日志，
 * 不能阻断墓碑记录、最终列表广播等卸载收尾。
 */
export function removeGhostKvBestEffort(
  store: Pick<GhostKvStore, 'remove'>,
  ghostId: string,
  log: GhostKvLogger,
): void {
  try {
    store.remove(ghostId);
  } catch (error) {
    log.warn('ghost KV 清理失败', {
      ghostId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 带 code 的存储层错误(端点层据此映射 400/413,不外泄内部细节)。 */
export class GhostKvError extends Error {
  constructor(
    readonly code: 'INVALID_VALUE' | 'TOO_LARGE' | 'INVALID_GHOST_ID',
    message: string,
  ) {
    super(message);
    this.name = 'GhostKvError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验 + 序列化一体:合法返回序列化文本(顺手给 write 复用,避免二次
 * stringify),非法抛 GhostKvError。
 */
function serializeGhostKvValue(value: unknown): string {
  if (!isPlainObject(value)) {
    throw new GhostKvError('INVALID_VALUE', 'KV 值必须是 JSON object');
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new GhostKvError('INVALID_VALUE', 'KV 值必须可 JSON 序列化');
  }
  if (typeof text !== 'string') {
    // JSON.stringify 对含 toJSON 返回 undefined 等怪形态可能产出 undefined。
    throw new GhostKvError('INVALID_VALUE', 'KV 值必须可 JSON 序列化');
  }
  if (Buffer.byteLength(text, 'utf8') > GHOST_KV_MAX_BYTES) {
    throw new GhostKvError('TOO_LARGE', `KV 序列化后超过 ${GHOST_KV_MAX_BYTES} 字节上限`);
  }
  return text;
}

/** 值是否为合法 KV(plain object 且序列化 ≤ 上限);端点层预检用。 */
export function isValidGhostKvValue(v: unknown): v is Record<string, unknown> {
  try {
    serializeGhostKvValue(v);
    return true;
  } catch {
    return false;
  }
}

export function createGhostKvStore(options: {
  /** 存储根目录(生产 = path.join(app.getPath('userData'), 'ghost-kv'));惰性求值。 */
  getRootDir: () => string;
  log?: GhostKvLogger;
}): GhostKvStore {
  const { getRootDir, log } = options;

  const fileFor = (ghostId: string): string => {
    if (!isValidPluginStoragePart(ghostId)) {
      throw new GhostKvError('INVALID_GHOST_ID', `非法 ghostId: ${String(ghostId)}`);
    }
    return path.join(getRootDir(), `${ghostId}.json`);
  };

  return {
    read(ghostId) {
      let file: string;
      try {
        file = fileFor(ghostId);
      } catch {
        return {};
      }
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return {}; // 无文件 = 从未写过,缺省空对象
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return isPlainObject(parsed) ? parsed : {};
      } catch {
        log?.warn('ghost KV 文件损坏,按空对象处理', { ghostId });
        return {};
      }
    },

    readStrict(ghostId) {
      const file = fileFor(ghostId);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        // 无文件 = 从未写过(合法的"未配置");其它 IO 异常上抛给调用方。
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw err;
      }
      const parsed: unknown = JSON.parse(text); // 损坏即抛,不折叠成"未配置"
      return isPlainObject(parsed) ? parsed : {};
    },

    write(ghostId, value) {
      const file = fileFor(ghostId); // 非法 id 抛 INVALID_GHOST_ID
      const text = serializeGhostKvValue(value);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // tmp + rename 原子写(override-settings-file 同款;Windows rename 覆盖已有文件 OK)。
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
    },

    remove(ghostId) {
      let file: string;
      try {
        file = fileFor(ghostId);
      } catch {
        return; // 非法 id 无文件可删,幂等语义直接返回
      }
      fs.rmSync(file, { force: true });
    },
  };
}
