/**
 * ghostCredentialRejections —— 运行期凭证被拒台账(secret 类 key 的失效探测)。
 *
 * 动机:OAuth 有 401 单飞重刷 + invalid_grant 标 expired 的完整链路,而
 * user 源 secret key 被服务端吊销后没有任何检测——插件永远停在「已配置」
 * 态,agent 每次调用都失败。本模块在 networkSlot 代发收到 401/403 时记账,
 * 生命周期投影把它折算为 needs_reauth,发现层与插件页即知「要重新配置」。
 *
 * 设计边界:
 * - 只记 secret key(setup.requires 可引用的 ref),不记 OAuth / 连接——
 *   那两条链路已有自己的 expired 语义;401/403 由 networkSlot 在重试
 *   耗尽后上报,一次被拒只记一次(幂等)。
 * - 凭证重存(保险库写入)即视为用户已处置,按 ghostId 清账;setup change
 *   bus 的 secret 事件触发清理,无需额外 IPC。
 * - 持久化在 owner 作用域 userData 下(与其它意识宿主数据同生命周期);
 *   损坏时按空账处理(fail-open,不因为台账故障把可用插件判死)。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface GhostCredentialRejectionsStore {
  /** 该插件当前被记的被拒 secret keys(空 = 无账)。 */
  rejectedKeys(ghostId: string): readonly string[];
  /** 记账(幂等:同 key 重复记录不产生变化)。返回是否有实际变化。 */
  markRejected(ghostId: string, secretKey: string): boolean;
  /** 凭证重存后清账;返回是否有实际变化。 */
  clear(ghostId: string): boolean;
  /** 只清理刚刚被重存的 secret,不影响同插件的其它被拒 key。 */
  clearSecret(ghostId: string, secretKey: string): boolean;
  /** 连接 token 更新后清除该连接的被拒状态。 */
  clearConnection(ghostId: string, declKey: string, connectionId: string): boolean;
}

interface RejectionFile {
  /** ghostId → 被拒 secret key 列表 */
  ghosts: Record<string, string[]>;
}

const FILE_NAME = 'ghost-credential-rejections.json';

export function ghostConnectionRejectionRef(declKey: string, connectionId: string): string {
  return `connection:${declKey}:${connectionId}`;
}

/**
 * setup change 事件 → 台账清账(幂等兜底面,抽出可测)。
 *
 * 主写入路径(保险库重存 / 连接 token 更新)都在 emit 之前自己清过账;这里
 * 是订阅侧的兜底,覆盖未来新增的写入路径。返回是否有实际变化。
 *
 * 三条不清账的情形:
 * - `ghostId` 为空:`emitAll` 在无 keyed 订阅者时发的纯唤醒信号(共享宿主
 *   配置变更),不指向具体插件,没有可清的账;
 * - 无 `ref`:事件没说清是哪一项,不能按插件整体清(会误清其它被拒 key);
 * - `source: 'connection'` 但 ref 只有 declKey:清单类变更定位不到具体连接。
 */
export function applyGhostSetupChangeToRejections(
  store: GhostCredentialRejectionsStore,
  event: { ghostId: string; source: string; ref?: string },
): boolean {
  if (!event.ghostId || !event.ref) return false;
  if (event.source === 'secret') return store.clearSecret(event.ghostId, event.ref);
  if (event.source !== 'connection') return false;
  // 连接类记账 ref 是 `connection:<declKey>:<connectionId>`,而 bus 上的
  // connection ref 是 `<declKey>` 或 `<declKey>:<connectionId>`。declKey 字符集
  // 为 [a-z0-9_](manifest 校验保证)、connectionId 是 UUID,首个冒号即分界。
  const separator = event.ref.indexOf(':');
  if (separator <= 0 || separator >= event.ref.length - 1) return false;
  return store.clearConnection(
    event.ghostId,
    event.ref.slice(0, separator),
    event.ref.slice(separator + 1),
  );
}

export function createGhostCredentialRejectionsStore(args: {
  filePath: string;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}): GhostCredentialRejectionsStore {
  const { filePath, log } = args;
  let cache: RejectionFile | null = null;

  const load = (): RejectionFile => {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RejectionFile>;
      const ghosts = Object.create(null) as Record<string, string[]>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.ghosts &&
        typeof parsed.ghosts === 'object'
      ) {
        for (const [id, keys] of Object.entries(parsed.ghosts)) {
          ghosts[id] = Array.isArray(keys)
            ? keys.filter((k): k is string => typeof k === 'string')
            : [];
        }
      }
      cache = { ghosts };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log?.warn('credential rejections ledger unreadable, treating as empty', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      cache = { ghosts: Object.create(null) as Record<string, string[]> };
    }
    return cache;
  };

  const persist = (): void => {
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 原子写:先落临时文件再 rename,进程崩溃/断电不会留下半截 JSON
      // 把台账打坏(与 plugin-market ledger 同模式,含 Windows 替换处理)。
      fs.writeFileSync(tempPath, JSON.stringify(cache), { mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EEXIST')) {
          throw error;
        }
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
      }
    } catch (error) {
      log?.warn('credential rejections ledger write failed, keeping runtime state', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  };

  return {
    rejectedKeys(ghostId) {
      const ghosts = load().ghosts;
      return Object.hasOwn(ghosts, ghostId) ? [...ghosts[ghostId]] : [];
    },
    markRejected(ghostId, secretKey) {
      const file = load();
      const keys = Object.hasOwn(file.ghosts, ghostId) ? file.ghosts[ghostId] : [];
      if (keys.includes(secretKey)) return false;
      file.ghosts[ghostId] = [...keys, secretKey];
      persist();
      return true;
    },
    clear(ghostId) {
      const file = load();
      if (!Object.hasOwn(file.ghosts, ghostId)) return false;
      delete file.ghosts[ghostId];
      persist();
      return true;
    },
    clearSecret(ghostId, secretKey) {
      const file = load();
      const keys = file.ghosts[ghostId];
      if (!keys) return false;
      const nextKeys = keys.filter((key) => key !== secretKey);
      if (nextKeys.length === keys.length) return false;
      if (nextKeys.length === 0) delete file.ghosts[ghostId];
      else file.ghosts[ghostId] = nextKeys;
      persist();
      return true;
    },
    clearConnection(ghostId, declKey, connectionId) {
      return this.clearSecret(ghostId, ghostConnectionRejectionRef(declKey, connectionId));
    },
  };
}

export function ghostCredentialRejectionsPath(rootDir: string): string {
  return path.join(rootDir, FILE_NAME);
}
