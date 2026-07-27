/**
 * /connections 协议端点的纯函数分派层(network.connections 多连接的设置页
 * 通道——"地址 + 凭证成对多条"凭证形态,自建实例场景)。与
 * ghostSecretsEndpoint / ghostOauthEndpoint 同拓扑:与 Electron 解耦、单测
 * 直接覆盖(规范 14),唯一调用方是 electronSandboxAdapter 的
 * cindy-ghost:// 协议 handler(经 index.ts 注入的闭包供清单、管理器与
 * 受信确认弹窗)。
 *
 * 协议(意识 settingsHtml 页面用,`fetch('/connections')`):
 * - GET  /connections → 200 + 每条连接声明的状态:
 *   [{ key, label, maxConnections, connections: [{id, host, label, isDefault, tail}] }]
 *   (tail = token 尾 4 位指纹;**永远零 token 字节**);
 * - POST /connections/<key>  body {"host":"...","token":"...","label":"..."?}
 *   添加或更新一条连接:
 *   - host 非法(带通配/单段/IP/协议等)→ 400 {ok:false,error:'INVALID_HOST'};
 *   - token 空/形态错 → 400 {ok:false,error:'INVALID_TOKEN'};超长 → 413;
 *   - label 形态错(非字符串/超 64 字)→ 400 {ok:false,error:'INVALID_LABEL'};
 *   - **新 host 先过主机受信确认弹窗**(confirmAddHost,动态白名单不能凭
 *     意识自绘页面单方面扩张),用户拒绝 → 200 {ok:false,error:'CONFIRM_DENIED'};
 *     同 host 只换 token/label 不再确认(放行面没变);
 *   - 超声明上限 → 200 {ok:false,error:'LIMIT'};
 *   - 保险库写失败 → 200 {ok:false,error:'VAULT_WRITE_FAILED'};
 *   - 成功 → 200 {ok:true, connection:{id,host,label,isDefault,tail}};
 * - DELETE /connections/<key>/<id> → 204(幂等);
 * - POST /connections/<key>/default  body {"connectionId":"..."} → 204;未知 id 404;
 * - 未声明的 key 一律 404;根路径 GET 之外 405;坏 body → 400。
 *
 * 安全模型:token 是**只写**的(GET 只回状态与尾 4 位指纹),保管
 * (safeStorage)与注入(主机代发请求时按连接自身地址精确匹配)由主机独占。
 */

import { GhostKvError } from '../ghostKvStore.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from './ghostSecretsEndpoint.js';
import { normalizeGhostConnectionHost } from '../ghostConnections.js';
import type { GhostConnectionUpsertResult, GhostConnectionView } from '../ghostConnections.js';

export interface GhostConnectionsRequestOutcome {
  status: number;
  /** 有 body 时恒为 JSON 文本(调用方统一佩 application/json 头)。 */
  body?: string;
}

/** 连接管理最小面(生产注入 GhostConnectionManager;测试喂假体)。 */
export interface GhostConnectionsEndpointManager {
  list(ghostId: string, declKey: string): GhostConnectionView[];
  upsert(
    ghostId: string,
    declKey: string,
    params: { host: string; token: string; label?: string; max: number },
  ): GhostConnectionUpsertResult;
  remove(ghostId: string, declKey: string, connectionId: string): void;
  setDefault(ghostId: string, declKey: string, connectionId: string): boolean;
}

export async function handleGhostConnectionsRequest(args: {
  method: string;
  /** '/connections' 或 '/connections/<key>[/...]'。 */
  pathname: string;
  /** 惰性读 body(调用方给有界读取器;只在 POST 消费)。 */
  readBodyText: () => Promise<string>;
  /** 当前清单里的连接声明(key → {label, maxConnections};现查在装清单,不吃缓存)。 */
  decls: ReadonlyMap<string, { label: string; maxConnections: number }>;
  manager: GhostConnectionsEndpointManager;
  ghostId: string;
  /**
   * 新增地址的主机受信确认(main 侧模态弹窗;index.ts 注入)。返回 false =
   * 用户拒绝。弹窗抛错按拒绝收(fail-closed:确认不了就不扩白名单)。
   */
  confirmAddHost: (declLabel: string, host: string) => Promise<boolean>;
  /** Any committed connection mutation; used to re-assess setup readiness. */
  onChanged?: (declKey: string) => void;
  /** New-connection user notice, separate from the complete mutation hook. */
  onAdded?: (declKey: string) => void;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<GhostConnectionsRequestOutcome> {
  const { method, pathname, readBodyText, decls, manager, ghostId, log } = args;
  const notifyChanged = (declKey: string): void => {
    try {
      args.onChanged?.(declKey);
    } catch (err) {
      log?.warn('ghost connections onChanged 通知失败(不影响入库结果)', {
        ghostId,
        declKey,
        err: String(err),
      });
    }
  };

  const json = (status: number, payload: unknown): GhostConnectionsRequestOutcome => ({
    status,
    body: JSON.stringify(payload),
  });

  if (pathname === '/connections') {
    if (method !== 'GET') return { status: 405 };
    try {
      const list = Array.from(decls.entries()).map(([key, decl]) => ({
        key,
        label: decl.label,
        maxConnections: decl.maxConnections,
        connections: manager.list(ghostId, key),
      }));
      return json(200, list);
    } catch (err) {
      log?.warn('ghost connections 状态回查失败', { ghostId, err: String(err) });
      return { status: 500 };
    }
  }

  // /connections/<key>[/<...>]
  const segments = pathname.slice('/connections/'.length).split('/');
  const declKey = segments[0] ?? '';
  // 只认当前清单里声明过的键——未声明/已下线统一 404,不给沙箱区分面。
  const decl = declKey ? decls.get(declKey) : undefined;
  if (!decl) return { status: 404 };

  // POST /connections/<key>:添加或更新一条连接。
  if (segments.length === 1) {
    if (method !== 'POST') return { status: 405 };
    let text: string;
    try {
      text = await readBodyText();
    } catch (err) {
      if (err instanceof GhostKvError && err.code === 'TOO_LARGE') return { status: 413 };
      return { status: 400 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: 400 };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 400 };
    const body = parsed as { host?: unknown; token?: unknown; label?: unknown };
    // host:小写化后必须是具体域名(不含通配;与静态白名单条目同形状校验)。
    const host = normalizeGhostConnectionHost(body.host);
    if (!host) return json(400, { ok: false, error: 'INVALID_HOST' });
    // token:非空字符串,超长 413(与 /secrets 同上限)。
    if (typeof body.token !== 'string' || body.token.trim().length === 0) {
      return json(400, { ok: false, error: 'INVALID_TOKEN' });
    }
    const token = body.token.trim();
    if (token.length > GHOST_SECRET_VALUE_MAX_CHARS) {
      return json(413, { ok: false, error: 'TOKEN_TOO_LONG' });
    }
    let label: string | undefined;
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || body.label.trim().length === 0 || body.label.length > 64) {
        return json(400, { ok: false, error: 'INVALID_LABEL' });
      }
      label = body.label.trim();
    }
    try {
      // 新 host 才弹受信确认(动态白名单扩张必须过用户);同 host 更新
      // token/label 放行面没变,不再打扰。弹窗异常按拒绝收(fail-closed)。
      const isNew = !manager.list(ghostId, declKey).some((c) => c.host === host);
      if (isNew) {
        let allowed = false;
        try {
          allowed = await args.confirmAddHost(decl.label, host);
        } catch (err) {
          log?.warn('ghost connections 受信确认弹窗异常(按拒绝收)', { ghostId, declKey, err: String(err) });
          allowed = false;
        }
        if (!allowed) return json(200, { ok: false, error: 'CONFIRM_DENIED' });
      }
      const result = manager.upsert(ghostId, declKey, {
        host,
        token,
        ...(label !== undefined ? { label } : {}),
        max: decl.maxConnections,
      });
      if (!result.ok) return json(200, { ok: false, error: result.error });
      try {
        notifyChanged(declKey);
        if (!result.updated) args.onAdded?.(declKey);
      } catch (err) {
        log?.warn('ghost connections change 通知失败(不影响入库结果)', { ghostId, declKey, err: String(err) });
      }
      return json(200, { ok: true, connection: result.connection });
    } catch (err) {
      log?.warn('ghost connections 入库意外失败', { ghostId, declKey, err: String(err) });
      return { status: 500 };
    }
  }

  if (segments.length === 2) {
    // POST /connections/<key>/default:设默认连接。
    if (segments[1] === 'default') {
      if (method !== 'POST') return { status: 405 };
      let text: string;
      try {
        text = await readBodyText();
      } catch (err) {
        if (err instanceof GhostKvError && err.code === 'TOO_LARGE') return { status: 413 };
        return { status: 400 };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { status: 400 };
      }
      const connectionId =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as { connectionId?: unknown }).connectionId
          : undefined;
      if (typeof connectionId !== 'string' || connectionId.length === 0) return { status: 400 };
      try {
        if (!manager.setDefault(ghostId, declKey, connectionId)) return { status: 404 };
        notifyChanged(declKey);
        return { status: 204 };
      } catch (err) {
        log?.warn('ghost connections 设默认连接意外失败', { ghostId, declKey, err: String(err) });
        return { status: 500 };
      }
    }
    // DELETE /connections/<key>/<id>:删除连接(幂等)。
    if (method !== 'DELETE') return { status: 405 };
    const connectionId = segments[1];
    if (!connectionId) return { status: 404 };
    try {
      manager.remove(ghostId, declKey, connectionId);
      notifyChanged(declKey);
      return { status: 204 };
    } catch (err) {
      log?.warn('ghost connections 删除连接意外失败', { ghostId, declKey, err: String(err) });
      return { status: 500 };
    }
  }

  return { status: 404 };
}
