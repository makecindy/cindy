/**
 * /oauth 协议端点的纯函数分派层(source:'oauth' 凭证的设置页通道)。
 * 与 ghostSecretsEndpoint 同拓扑:与 Electron 解耦、单测直接覆盖(规范 14),
 * 唯一调用方是 electronSandboxAdapter 的 cindy-ghost:// 协议 handler。
 *
 * 协议(意识 settingsHtml 页面用,`fetch('/oauth')`):
 * - GET  /oauth                          → 200 + [{ key, clientConfigured, accounts }]
 *   (仅 source:'oauth' 的凭证;accounts 只含 {id,label,status,isDefault,
 *   avatarDataUrl,scopeStale},零令牌字节——avatarDataUrl 是主机下载转码
 *   的头像小图,scopeStale 是宿主据真实缺权证据或授权面快照计算的非阻塞提示);
 * - PUT  /oauth/<key>/client             → body {"clientId":"...","clientSecret":"..."}
 *   写入用户自填的 OAuth 客户端凭证(clientSecret 可省略 = 纯 PKCE),204;
 * - DELETE /oauth/<key>/client           → 清除 client 凭证,204(幂等);
 * - POST /oauth/<key>/connect            → 可选 body {scopes,clientId};scopes
 *   只能是声明子集,clientId 仅 broker 模式且只能取默认/备用声明值。主机跑
 *   完整授权流程(拉浏览器,最长
 *   数分钟),200 + {ok:true,account} 或 {ok:false,error}(结构化错误码,
 *   settingsHtml 据此提示;永不外泄令牌/凭证字节);
 * - DELETE /oauth/<key>/accounts/<id>    → 断开账号,204(幂等);
 * - POST /oauth/<key>/default            → body {"accountId":"..."} 设默认账号,
 *   204;账号不存在 404;
 * - POST /oauth/<key>/insufficient-scopes → body {"scopes":[...]} 上报真实 API
 *   返回的缺失权限证据；只接受当前清单声明内的 scope，成功 204;
 * - 未声明 / 非 oauth 的 key → 404;坏 body / 空值 → 400;值超长 → 413;
 *   其它 method → 405;保险库写失败 → 500(不外泄细节)。
 *
 * 安全模型:client 凭证是**只写**的(GET 只回 clientConfigured 布尔);授权
 * 产生的全部令牌只存在主机保险库与内存缓存,本端点没有任何读回动作。
 */

import { isOfficialGhostId } from '../../../shared/ghost.js';
import { GhostKvError } from '../ghostKvStore.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from './ghostSecretsEndpoint.js';
import type {
  GhostOauthAccountView,
  GhostOauthConnectResult,
  GhostOauthDecl,
} from '../ghostOauthAccounts.js';

export interface GhostOauthRequestOutcome {
  status: number;
  /** 有 body 时恒为 JSON 文本(调用方统一佩 application/json 头)。 */
  body?: string;
}

/** 账号/凭证管理最小面(生产注入 GhostOauthAccountManager;测试喂假体)。 */
export interface GhostOauthEndpointManager {
  /** 可用 = 用户自填或清单内置任一在场(decl 供内置回落判定)。 */
  clientConfigured(ghostId: string, secretKey: string, decl?: GhostOauthDecl): boolean;
  /** 用户是否自填过(UI 区分"内置应用身份 / 已自定义")。 */
  clientCustomized(ghostId: string, secretKey: string): boolean;
  setClientConfig(
    ghostId: string,
    secretKey: string,
    clientId: string,
    clientSecret?: string,
  ): boolean;
  clearClientConfig(ghostId: string, secretKey: string): void;
  listAccounts(ghostId: string, secretKey: string, decl?: GhostOauthDecl): GhostOauthAccountView[];
  connectAccount(
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
    opts?: {
      scopes?: readonly string[];
      clientId?: string;
      deliveryHosts?: readonly string[];
    },
  ): Promise<GhostOauthConnectResult>;
  disconnectAccount(ghostId: string, secretKey: string, accountId: string): void;
  setDefaultAccount(ghostId: string, secretKey: string, accountId: string): boolean;
  /** 'unchanged' = 证据已在库未重写(调用方跳过广播);false = 无默认账号或写失败。 */
  reportInsufficientScopes(
    ghostId: string,
    secretKey: string,
    scopes: readonly string[],
    declScopes: readonly string[],
  ): 'stored' | 'unchanged' | false;
}

export async function handleGhostOauthRequest(args: {
  method: string;
  /** '/oauth' 或 '/oauth/<key>/...'。 */
  pathname: string;
  /** 惰性读 body(调用方给有界读取器;只在 PUT/POST 消费)。 */
  readBodyText: () => Promise<string>;
  /** 当前清单里 source:'oauth' 的凭证(key → 授权详单;现查在装清单,不吃缓存)。 */
  oauthSecrets: ReadonlyMap<string, GhostOauthDecl>;
  /** 清单 network.hosts 白名单——跨源 code 投递允许面的派生输入(见 connectAccount)。 */
  networkHosts?: readonly string[];
  manager: GhostOauthEndpointManager;
  ghostId: string;
  /** Serialize credential/account persistence with package OAuth migration. */
  withMutationLock?: <T>(ghostId: string, task: () => Promise<T> | T) => Promise<T>;
  /** Successful semantic persistence only; never receives credential values. */
  onChanged?: (secretKey: string) => void;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<GhostOauthRequestOutcome> {
  const { method, pathname, readBodyText, oauthSecrets, networkHosts, manager, ghostId, log } =
    args;
  const runMutation = <T>(task: () => Promise<T> | T): Promise<T> =>
    args.withMutationLock?.(ghostId, task) ?? Promise.resolve(task());
  const notifyChanged = (secretKey: string): void => {
    try {
      args.onChanged?.(secretKey);
    } catch (err) {
      log?.warn('ghost oauth onChanged 通知失败(不影响入库结果)', {
        ghostId,
        secretKey,
        err: String(err),
      });
    }
  };

  if (pathname === '/oauth') {
    if (method !== 'GET') return { status: 405 };
    try {
      const list = Array.from(oauthSecrets.entries()).map(([key, keyDecl]) => ({
        key,
        clientConfigured: manager.clientConfigured(ghostId, key, keyDecl),
        // 自填与内置分开报:settingsHtml 据此显示"内置应用身份 / 已自定义"。
        clientCustom: manager.clientCustomized(ghostId, key),
        accounts: manager.listAccounts(ghostId, key, keyDecl),
      }));
      return { status: 200, body: JSON.stringify(list) };
    } catch (err) {
      log?.warn('ghost oauth 状态回查失败', { ghostId, err: String(err) });
      return { status: 500 };
    }
  }

  // /oauth/<key>/<action>[/<accountId>]
  const segments = pathname.slice('/oauth/'.length).split('/');
  const secretKey = segments[0] ?? '';
  // 只认当前清单里 source:'oauth' 的键——非 oauth/未声明/已下线统一 404,
  // 不给沙箱区分面。
  const decl = secretKey ? oauthSecrets.get(secretKey) : undefined;
  if (!decl) return { status: 404 };
  const action = segments[1] ?? '';

  const readJsonBody = async (): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; status: number }
  > => {
    let text: string;
    try {
      text = await readBodyText();
    } catch (err) {
      if (err instanceof GhostKvError && err.code === 'TOO_LARGE')
        return { ok: false, status: 413 };
      return { ok: false, status: 400 };
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, status: 400 };
      }
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, status: 400 };
    }
  };

  if (action === 'client' && segments.length === 2) {
    // tokenBroker 模式:client secret 在服务端、clientId 恒用内置,自填/清除
    // 都没有语义(自填 id 配服务端 secret 必 invalid_client),一律 405。
    if (decl.tokenBroker !== undefined) return { status: 405 };
    if (method === 'PUT' || method === 'POST') {
      const parsed = await readJsonBody();
      if (!parsed.ok) return { status: parsed.status };
      const body = parsed.body;
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
      if (clientId.length === 0) return { status: 400 };
      if (clientId.length > GHOST_SECRET_VALUE_MAX_CHARS) return { status: 413 };
      let clientSecret: string | undefined;
      if (body.clientSecret !== undefined) {
        if (typeof body.clientSecret !== 'string') return { status: 400 };
        const trimmed = body.clientSecret.trim();
        if (trimmed.length > GHOST_SECRET_VALUE_MAX_CHARS) return { status: 413 };
        clientSecret = trimmed.length > 0 ? trimmed : undefined;
      }
      try {
        if (!(await runMutation(() =>
          manager.setClientConfig(ghostId, secretKey, clientId, clientSecret)))) {
          return { status: 500 };
        }
        notifyChanged(secretKey);
        return { status: 204 };
      } catch (err) {
        log?.warn('ghost oauth client 凭证入库意外失败', { ghostId, secretKey, err: String(err) });
        return { status: 500 };
      }
    }
    if (method === 'DELETE') {
      try {
        await runMutation(() => manager.clearClientConfig(ghostId, secretKey));
        notifyChanged(secretKey);
        return { status: 204 };
      } catch (err) {
        log?.warn('ghost oauth client 凭证清除意外失败', { ghostId, secretKey, err: String(err) });
        return { status: 500 };
      }
    }
    return { status: 405 };
  }

  if (action === 'connect' && segments.length === 2) {
    if (method !== 'POST') return { status: 405 };
    // tokenBroker 第一方门控·连接闸(装入闸的运行时兜底,覆盖 dev 装入等
    // 旁路):XDT 授权 broker 只对官方前缀意识开放。
    if (decl.tokenBroker !== undefined && !isOfficialGhostId(ghostId)) {
      return {
        status: 200,
        body: JSON.stringify({
          ok: false,
          error: 'BROKER_FORBIDDEN',
          detail: 'tokenBroker 仅第一方官方意识可用',
        }),
      };
    }
    // 可选 body {"scopes":[...],"clientId":"..."}:scopes 是本次授权申请
    // 清单的非空子集;clientId 仅 broker 模式可从默认/备用声明值中选择。
    // (设置页"只读连接"这类降面授权)。无 body / 空 body = 申请全量声明面;
    // 越界或形态不对 400(意识不能借连接动作扩权,manager 侧还有防御性重验)。
    let scopesOverride: string[] | undefined;
    let clientIdOverride: string | undefined;
    try {
      const text = await readBodyText();
      if (text.trim().length > 0) {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          return { status: 400 };
        const rawScopes = (parsed as Record<string, unknown>).scopes;
        if (rawScopes !== undefined) {
          if (!Array.isArray(rawScopes) || rawScopes.length === 0) return { status: 400 };
          const declared = new Set(decl.scopes ?? []);
          const collected: string[] = [];
          for (const sc of rawScopes) {
            if (typeof sc !== 'string' || !declared.has(sc)) return { status: 400 };
            if (!collected.includes(sc)) collected.push(sc);
          }
          scopesOverride = collected;
        }
        const rawClientId = (parsed as Record<string, unknown>).clientId;
        if (rawClientId !== undefined) {
          if (
            typeof rawClientId !== 'string' ||
            rawClientId.trim().length === 0 ||
            rawClientId.length > 200 ||
            /\s/.test(rawClientId)
          ) {
            return { status: 400 };
          }
          const normalized = rawClientId.trim();
          const allowedClientIds = [decl.clientId, ...(decl.clientIdAlternatives ?? [])];
          if (!decl.tokenBroker || !allowedClientIds.includes(normalized)) {
            return { status: 400 };
          }
          clientIdOverride = normalized;
        }
      }
    } catch (err) {
      if (err instanceof GhostKvError && err.code === 'TOO_LARGE') return { status: 413 };
      return { status: 400 };
    }
    try {
      const opts = {
        ...(scopesOverride !== undefined ? { scopes: scopesOverride } : {}),
        ...(clientIdOverride !== undefined ? { clientId: clientIdOverride } : {}),
        ...(networkHosts?.length ? { deliveryHosts: networkHosts } : {}),
      };
      const result = await manager.connectAccount(
        ghostId,
        secretKey,
        decl,
        Object.keys(opts).length > 0 ? opts : undefined,
      );
      // 结构化透传(ok:false 也是 200——授权被拒/超时是业务态不是协议错;
      // detail 可能含服务端错误摘录,已由引擎保证不含凭证字节)。
      return { status: 200, body: JSON.stringify(result) };
    } catch (err) {
      log?.warn('ghost oauth 授权流程意外失败', { ghostId, secretKey, err: String(err) });
      return { status: 500 };
    }
  }

  if (action === 'insufficient-scopes' && segments.length === 2) {
    if (method !== 'POST') return { status: 405 };
    const parsed = await readJsonBody();
    if (!parsed.ok) return { status: parsed.status };
    const rawScopes = parsed.body.scopes;
    if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.length > 320) {
      return { status: 400 };
    }
    // 逐字属于声明面即形状合法(清单校验已保证声明 scope ≤200 字符、无空白),
    // 任一越界整包 400;重复条目由存取层合并去重。
    const declared = new Set(decl.scopes ?? []);
    const scopes: string[] = [];
    for (const scope of rawScopes) {
      if (typeof scope !== 'string' || !declared.has(scope)) return { status: 400 };
      scopes.push(scope);
    }
    try {
      const stored = await runMutation(() =>
        manager.reportInsufficientScopes(ghostId, secretKey, scopes, decl.scopes ?? []),
      );
      if (stored === false) return { status: 500 };
      // 证据未变时不广播:插件在用户重连前会反复撞同一权限错误并 fire-and-forget
      // 重报,无变更广播只会空转投影与在途配置卡的重评估循环。
      if (stored === 'stored') notifyChanged(secretKey);
      return { status: 204 };
    } catch (err) {
      log?.warn('ghost oauth 缺失 scope 证据入库失败', { ghostId, secretKey, err: String(err) });
      return { status: 500 };
    }
  }

  if (action === 'accounts' && segments.length === 3) {
    if (method !== 'DELETE') return { status: 405 };
    const accountId = segments[2];
    if (!accountId) return { status: 404 };
    try {
      await runMutation(() => manager.disconnectAccount(ghostId, secretKey, accountId));
      notifyChanged(secretKey);
      return { status: 204 };
    } catch (err) {
      log?.warn('ghost oauth 断开账号意外失败', { ghostId, secretKey, err: String(err) });
      return { status: 500 };
    }
  }

  if (action === 'default' && segments.length === 2) {
    if (method !== 'POST') return { status: 405 };
    const parsed = await readJsonBody();
    if (!parsed.ok) return { status: parsed.status };
    const accountId = parsed.body.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) return { status: 400 };
    try {
      if (!(await runMutation(() => manager.setDefaultAccount(ghostId, secretKey, accountId)))) {
        return { status: 404 };
      }
      notifyChanged(secretKey);
      return { status: 204 };
    } catch (err) {
      log?.warn('ghost oauth 设默认账号意外失败', { ghostId, secretKey, err: String(err) });
      return { status: 500 };
    }
  }

  return { status: 404 };
}
