/**
 * ghostConnections.ts — 意识多连接(connections)的地址与凭证管理器。
 * ---------------------------------------------------------------------------
 * network 槽"地址 + 凭证成对多条"凭证形态(GhostConnectionDecl,自建实例
 * 场景如 Cindy GitLab)的主机侧真身。镜像 ghostOauthAccounts 的存储形态,
 * 管一条连接声明(declKey)名下的:
 * - 连接清单(id / 小写裸域 host / 展示标签 / 默认连接),JSON 落主机保险库;
 * - 每条连接的 token 按连接落库(providerSecretStore 入库时连带截存尾 4 位
 *   指纹,设置页状态回查用);
 * - 出网注入按 host 精确解析 token(resolveTokenByHost,networkSlot 消费)。
 *
 * 保险库键名纪律:与 ghostOauthAccounts 同一套——派生键统一
 * `<declKey>-<后缀>` 形态。declKey 字符集是 [a-z0-9_](validateGhostManifest
 * 把关,不含连字符),派生键与任何已声明凭证键在结构上不可能撞名;连字符是
 * providerSecretStore 键名字符集(SAFE_KEY_PART_RE)允许的字符。
 * - `<declKey>-connections`:连接清单 JSON(不含任何 token 字节);
 * - `<declKey>-token-<connectionId>`:该连接的 token(connectionId 为 UUID)。
 *
 * 卸下意识时的清理:providerSecretStore.removeGhostSecrets 按
 * `ghost_secret_<ghostId>_` 前缀清扫,上述派生键天然连带,无需新代码。
 *
 * 安全纪律与 networkSlot 一致:token 明文不进沙箱、不进日志、不进清单;
 * 对外(设置页 /connections 端点)只暴露 {id, host, label, isDefault, tail}。
 *
 * 依赖注入(规则 14):保险库全经 deps.vault,单测用内存假体全覆盖,零 Electron。
 */

import { randomUUID } from 'node:crypto';

import { isValidGhostNetworkHostPattern } from '../../shared/ghost.js';

/* ------------------------------------------------------------------------ */
/* 契约类型                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * 保险库最小面(providerSecretStore 在接线处适配;测试喂内存假体)。
 * readTail = 尾 4 位指纹(providerSecretStore 入库时预截),设置页回查用。
 */
export interface GhostConnectionsVault {
  read(ghostId: string, storageKey: string): string | null;
  /** 返回 false = 写失败(safeStorage 不可用等),调用方折叠结构化错误。 */
  store(ghostId: string, storageKey: string, value: string): boolean;
  remove(ghostId: string, storageKey: string): void;
  /** 尾 4 位指纹;没存过 / 值太短不产指纹时返回 null。 */
  readTail(ghostId: string, storageKey: string): string | null;
}

export interface GhostConnectionManagerDeps {
  vault: GhostConnectionsVault;
}

/** 对外(设置页 /connections 端点)暴露的连接形态——零 token 字节。 */
export interface GhostConnectionView {
  id: string;
  /** 小写裸域(如 gitlab.example.com)。 */
  host: string;
  label: string | null;
  isDefault: boolean;
  /** token 尾 4 位指纹(帮用户回忆填的是哪个;值太短不产时 null)。 */
  tail: string | null;
}

export type GhostConnectionUpsertResult =
  | { ok: true; connection: GhostConnectionView; /** true = 同 host 已存在,只换了 token/label。 */ updated: boolean }
  | { ok: false; error: 'LIMIT' | 'VAULT_WRITE_FAILED' };

/* ------------------------------------------------------------------------ */
/* host 合法性(端点与测试共用)                                              */
/* ------------------------------------------------------------------------ */

/**
 * 归一化并校验一条连接地址:小写化去首尾空白后必须过 network 白名单条目的
 * 域名形状校验,且**不含通配**(自建地址必须是具体域名——动态白名单按精确
 * 匹配放行,通配会把放行面撕开)。非法返回 null。
 */
export function normalizeGhostConnectionHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  if (host.includes('*')) return null;
  if (!isValidGhostNetworkHostPattern(host)) return null;
  return host;
}

/* ------------------------------------------------------------------------ */
/* 内部持久化形态                                                            */
/* ------------------------------------------------------------------------ */

interface ConnectionRow {
  id: string;
  host: string;
  label: string | null;
  createdAt: number;
}

interface ConnectionsManifest {
  defaultConnectionId: string | null;
  connections: ConnectionRow[];
}

const EMPTY_MANIFEST: ConnectionsManifest = { defaultConnectionId: null, connections: [] };

function connectionsKey(declKey: string): string {
  return `${declKey}-connections`;
}
function tokenKey(declKey: string, connectionId: string): string {
  return `${declKey}-token-${connectionId}`;
}

/** 容错解析连接清单(坏形态当空,不让一条脏数据卡死整条连接声明)。 */
function parseManifest(raw: string | null): ConnectionsManifest {
  if (!raw) return EMPTY_MANIFEST;
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionsManifest>;
    if (!Array.isArray(parsed.connections)) return EMPTY_MANIFEST;
    const connections: ConnectionRow[] = [];
    for (const row of parsed.connections) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Partial<ConnectionRow>;
      if (typeof r.id !== 'string' || r.id.length === 0) continue;
      if (typeof r.host !== 'string' || r.host.length === 0) continue;
      connections.push({
        id: r.id,
        host: r.host.toLowerCase(),
        label: typeof r.label === 'string' && r.label.length > 0 ? r.label : null,
        createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
      });
    }
    const defaultConnectionId =
      typeof parsed.defaultConnectionId === 'string' &&
      connections.some((c) => c.id === parsed.defaultConnectionId)
        ? parsed.defaultConnectionId
        : connections.length > 0
          ? connections[0].id
          : null;
    return { defaultConnectionId, connections };
  } catch {
    return EMPTY_MANIFEST;
  }
}

/* ------------------------------------------------------------------------ */
/* 管理器                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * 一个进程级单例管所有意识的所有连接声明(清单按 ghostId + declKey 分键,
 * 互不串)。接线处(cindy-brain/index.ts)构造一次,注入 /connections 端点
 * 与 networkSlot 两个消费方。
 */
export class GhostConnectionManager {
  private readonly deps: GhostConnectionManagerDeps;

  constructor(deps: GhostConnectionManagerDeps) {
    this.deps = deps;
  }

  /** 某声明名下的全部连接(设置页回查;tail 为 token 尾 4 位指纹)。 */
  list(ghostId: string, declKey: string): GhostConnectionView[] {
    const manifest = parseManifest(this.deps.vault.read(ghostId, connectionsKey(declKey)));
    return manifest.connections.map((row) => ({
      id: row.id,
      host: row.host,
      label: row.label,
      isDefault: row.id === manifest.defaultConnectionId,
      tail: this.deps.vault.readTail(ghostId, tokenKey(declKey, row.id)),
    }));
  }

  /**
   * 添加或更新一条连接。同 host(大小写不敏感)已存在 = **更新语义**:只换
   * token / label,不新增行(id 稳定,意识侧记住的连接 id 不因用户换 token
   * 失效);新 host = 新增:**先 token 后清单**,清单写失败回滚 token(防
   * "清单有连接但无 token"的半身位),超 max 拒 LIMIT(上限只拦真新增)。
   */
  upsert(
    ghostId: string,
    declKey: string,
    params: { host: string; token: string; label?: string; max: number },
  ): GhostConnectionUpsertResult {
    const host = params.host.trim().toLowerCase();
    const manifest = parseManifest(this.deps.vault.read(ghostId, connectionsKey(declKey)));
    const existing = manifest.connections.find((c) => c.host === host);
    if (existing) {
      if (!this.deps.vault.store(ghostId, tokenKey(declKey, existing.id), params.token)) {
        return { ok: false, error: 'VAULT_WRITE_FAILED' };
      }
      if (params.label !== undefined && params.label !== existing.label) {
        existing.label = params.label;
        if (!this.deps.vault.store(ghostId, connectionsKey(declKey), JSON.stringify(manifest))) {
          return { ok: false, error: 'VAULT_WRITE_FAILED' };
        }
      }
      return { ok: true, updated: true, connection: this.toView(ghostId, declKey, existing, manifest.defaultConnectionId) };
    }
    if (manifest.connections.length >= params.max) {
      return { ok: false, error: 'LIMIT' };
    }
    const row: ConnectionRow = {
      id: randomUUID(),
      host,
      label: params.label ?? null,
      createdAt: Date.now(),
    };
    // 先 token 后清单:清单是"连接存在"的事实源,顺序反了会出现"清单有
    // 连接但无 token"的半身位(出网必然快速失败还引导不了用户)。
    if (!this.deps.vault.store(ghostId, tokenKey(declKey, row.id), params.token)) {
      return { ok: false, error: 'VAULT_WRITE_FAILED' };
    }
    const nextManifest: ConnectionsManifest = {
      defaultConnectionId: manifest.defaultConnectionId ?? row.id,
      connections: [...manifest.connections, row],
    };
    if (!this.deps.vault.store(ghostId, connectionsKey(declKey), JSON.stringify(nextManifest))) {
      // 回滚 token,防孤儿凭证残留保险库。
      this.deps.vault.remove(ghostId, tokenKey(declKey, row.id));
      return { ok: false, error: 'VAULT_WRITE_FAILED' };
    }
    return { ok: true, updated: false, connection: this.toView(ghostId, declKey, row, nextManifest.defaultConnectionId) };
  }

  /** 删除连接:清 token、从清单摘除(幂等);默认位被删则指到剩余第一条或 null。 */
  remove(ghostId: string, declKey: string, connectionId: string): void {
    const manifest = parseManifest(this.deps.vault.read(ghostId, connectionsKey(declKey)));
    this.deps.vault.remove(ghostId, tokenKey(declKey, connectionId));
    if (!manifest.connections.some((c) => c.id === connectionId)) return;
    const remaining = manifest.connections.filter((c) => c.id !== connectionId);
    this.deps.vault.store(
      ghostId,
      connectionsKey(declKey),
      JSON.stringify({
        defaultConnectionId:
          manifest.defaultConnectionId === connectionId
            ? (remaining[0]?.id ?? null)
            : manifest.defaultConnectionId,
        connections: remaining,
      } satisfies ConnectionsManifest),
    );
  }

  /** 设默认连接;未知 id 返回 false。 */
  setDefault(ghostId: string, declKey: string, connectionId: string): boolean {
    const manifest = parseManifest(this.deps.vault.read(ghostId, connectionsKey(declKey)));
    if (!manifest.connections.some((c) => c.id === connectionId)) return false;
    return this.deps.vault.store(
      ghostId,
      connectionsKey(declKey),
      JSON.stringify({ ...manifest, defaultConnectionId: connectionId }),
    );
  }

  /** 某声明名下用户已添加的全部地址(networkSlot 动态白名单用;小写裸域)。 */
  hostsOf(ghostId: string, declKey: string): string[] {
    return parseManifest(this.deps.vault.read(ghostId, connectionsKey(declKey))).connections.map(
      (c) => c.host,
    );
  }

  /**
   * 按 hostname 精确解析 token(出网注入用):hostname 必须逐字等于某条连接
   * 的 host(大小写不敏感,不吃通配);查无该地址或 token 读不到均返回 null
   * (调用方按"凭证未配置"快速失败)。
   */
  resolveTokenByHost(ghostId: string, declKey: string, hostname: string): string | null {
    const target = hostname.trim().toLowerCase();
    const manifest = parseManifest(this.deps.vault.read(ghostId, connectionsKey(declKey)));
    const row = manifest.connections.find((c) => c.host === target);
    if (!row) return null;
    return this.deps.vault.read(ghostId, tokenKey(declKey, row.id));
  }

  private toView(
    ghostId: string,
    declKey: string,
    row: ConnectionRow,
    defaultConnectionId: string | null,
  ): GhostConnectionView {
    return {
      id: row.id,
      host: row.host,
      label: row.label,
      isDefault: row.id === defaultConnectionId,
      tail: this.deps.vault.readTail(ghostId, tokenKey(declKey, row.id)),
    };
  }
}
