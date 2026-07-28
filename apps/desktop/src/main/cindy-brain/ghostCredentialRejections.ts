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
}

interface RejectionFile {
  /** ghostId → 被拒 secret key 列表 */
  ghosts: Record<string, string[]>;
}

const FILE_NAME = 'ghost-credential-rejections.json';

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
      cache = {
        ghosts:
          parsed && typeof parsed === 'object' && parsed.ghosts && typeof parsed.ghosts === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.ghosts).map(([id, keys]) => [
                  id,
                  Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [],
                ]),
              )
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log?.warn('credential rejections ledger unreadable, treating as empty', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      cache = { ghosts: {} };
    }
    return cache;
  };

  const persist = (): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 原子写:先落临时文件再 rename,进程崩溃/断电不会留下半截 JSON
    // 把台账打坏(与 plugin-market ledger 同模式,含 Windows 替换处理)。
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
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
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  };

  return {
    rejectedKeys(ghostId) {
      return load().ghosts[ghostId] ?? [];
    },
    markRejected(ghostId, secretKey) {
      const file = load();
      const keys = file.ghosts[ghostId] ?? [];
      if (keys.includes(secretKey)) return false;
      file.ghosts[ghostId] = [...keys, secretKey];
      persist();
      return true;
    },
    clear(ghostId) {
      const file = load();
      if (!(ghostId in file.ghosts)) return false;
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
  };
}

export function ghostCredentialRejectionsPath(rootDir: string): string {
  return path.join(rootDir, FILE_NAME);
}
