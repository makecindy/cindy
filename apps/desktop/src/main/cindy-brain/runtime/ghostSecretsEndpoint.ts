/**
 * /secrets 协议端点的纯函数分派层(用户凭证的只写入库通道,FORGE_GUIDE
 * §4.7「意识收单」——宿主凭证渲染 2026-07-13 整体退役,network.secrets
 * 与 node.secretBindings 声明的用户凭证一律经此通道)。与
 * ghostKvEndpoint 同拓扑:与 Electron 解耦、单测直接覆盖
 * (规范 14),唯一调用方是 electronSandboxAdapter 的 cindy-ghost:// 协议
 * handler(经 index.ts 注入的闭包供清单与保险库)。
 *
 * 协议(意识 settingsHtml 页面用,`fetch('/secrets')`):
 * - GET  /secrets        → 200 + 每条声明凭证的状态:
 *   - user 来源:{ key, saved, tail? }(tail = 尾 4 位指纹,帮用户回忆填的
 *     是哪个 key——值太短不产指纹时缺省;老键由保险库真身首查懒回填,见
 *     readGhostSecretTailFromIo);
 *   - login-email 派生:{ key, saved, identity? }(identity = 当前登录邮箱,
 *     供设置页只读展示"用的是哪个身份"。回给意识不算新增泄露面:插件详情
 *     已披露"将使用你的登录邮箱",且该凭证每次代发都注给它自己的服务端。
 *     未登录/登录态缺邮箱 → saved:false 无 identity,页面照"请重新登录"画);
 *   - gh-cli 优先 + PAT 备用:{ key, saved, tail?, hostSource:'gh-cli',
 *     hostAvailable }。saved/tail 只描述保险库里的备用 PAT；hostAvailable
 *     只描述主机能否复用本机 gh 登录，不暴露 token 或账号资料；
 * - PUT  /secrets/<key>  → body {"value":"..."} 存入主机保险库,204;
 * - DELETE /secrets/<key> → 清除,204(幂等);
 * - login-email / Host 托管凭证键的任意单键操作 → 405(派生身份不可配置);
 * - 未声明的 key → 404;坏 body / 空值 → 400;
 *   值超长 → 413;其它 method → 405;保险库写失败 → 500(不外泄细节)。
 *
 * 安全模型(docs/dev-rules/plugin-security-and-authoring.md):这是**只写通道**——没有任何读回
 * 明文的动作,GET 只回"存没存"布尔 + 尾 4 位指纹(2026-07-13 Lizi 拍板的
 * 有意识降级:指纹在入库那一刻由主机截取、分键保管;老键的懒回填发生在
 * main 保险库层——与注入同权限的进程,本就每次代发都读明文——本端点及
 * 沙箱可见面始终只有预截的 4 个字符)。network 凭证仅在主机代发请求时
 * 注入;node.secretBindings 凭证仅由 broker 在清单限定的方法/入口请求中
 * 临时交给对应 Worker。两者都不经浏览器 main.js、Agent 参数或日志。
 * login-email 派生凭证没有收单动作,404 同未声明。
 */

import { GHOST_SECRET_VALUE_MAX_CHARS } from '../../../shared/ghost.js';
import { GhostKvError } from '../ghostKvStore.js';

/** 单条凭证值的字符上限(粘贴的 key/token 量级;超限 413)。 */
export { GHOST_SECRET_VALUE_MAX_CHARS };

export interface GhostSecretsRequestOutcome {
  status: number;
  /** 有 body 时恒为 JSON 文本(调用方统一佩 application/json 头)。 */
  body?: string;
}

/** 保险库最小面(main 侧 providerSecretStore 注入;测试喂内存假体)。 */
export interface GhostSecretsVault {
  saved(ghostId: string, secretKey: string): boolean;
  /** 尾 4 位指纹(预截值;老键由真身懒回填);值太短不产时返回 null。 */
  tail(ghostId: string, secretKey: string): string | null;
  /** 返回 false = safeStorage 写失败(端点折叠 500)。store 内部连带截存指纹。 */
  store(ghostId: string, secretKey: string, value: string): boolean;
  remove(ghostId: string, secretKey: string): void;
}

export async function handleGhostSecretsRequest(args: {
  method: string;
  /** '/secrets' 或 '/secrets/<key>'。 */
  pathname: string;
  /** 惰性读 body(调用方给有界读取器;只在 PUT 消费)。 */
  readBodyText: () => Promise<string>;
  /**
   * 当前清单里可由用户写入的凭证键(network user + node.secretBindings;
   * index.ts 现查在装清单,不吃缓存)。
   */
  userSecretKeys: string[];
  /** 清单里 source:'login-email' 的凭证键(只读身份:GET 回 identity,写/删 405)。 */
  identitySecretKeys?: string[];
  /** 现读当前登录邮箱(identity 条目的值来源);未登录/缺邮箱返回 null。 */
  getLoginEmail?: () => string | null;
  /** Host 托管凭证(source:'oidc-token')的就绪状态;值不进入意识可见接口。 */
  managedSecretStates?: Array<{ key: string; saved: boolean }>;
  /** 宿主优先凭证来源状态(当前仅 gh-cli),只回可用布尔。 */
  hostCredentialStates?: Array<{
    key: string;
    source: 'gh-cli';
    available: boolean;
  }>;
  vault: GhostSecretsVault;
  ghostId: string;
  /**
   * 入库成功(PUT/POST → 204)后的通知钩子(2026-07-14):调用方拿它广播
   * "凭证已保存"的主机代言 tips。只报成功——失败面(400/413/500)设置页
   * 自己有反馈,不额外打扰;DELETE 不报(清除不是值得全局提示的事件)。
   */
  onStored?: (secretKey: string) => void;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<GhostSecretsRequestOutcome> {
  const { method, pathname, readBodyText, userSecretKeys, vault, ghostId, log } = args;
  const identityKeys = args.identitySecretKeys ?? [];
  const managedStates = args.managedSecretStates ?? [];
  const managedKeys = managedStates.map(({ key }) => key);
  const hostCredentialStates = new Map(
    (args.hostCredentialStates ?? []).map((state) => [state.key, state] as const),
  );

  if (pathname === '/secrets') {
    if (method !== 'GET') return { status: 405 };
    try {
      const userList = userSecretKeys.map((key) => {
        const saved = vault.saved(ghostId, key);
        // 指纹只在"确实存了"时给(没存过的键即便留有孤儿指纹也不回)。
        const tail = saved ? vault.tail(ghostId, key) : null;
        const hostState = hostCredentialStates.get(key);
        const hostFields = hostState
          ? { hostSource: hostState.source, hostAvailable: hostState.available }
          : {};
        return tail
          ? { key, saved, tail, ...hostFields }
          : { key, saved, ...hostFields };
      });
      // 身份凭证:现读登录邮箱只读展示;identityKeys 为空时不碰登录态。
      const email = identityKeys.length > 0 ? (args.getLoginEmail?.()?.trim() ?? '') : '';
      const identityList = identityKeys.map((key) =>
        email ? { key, saved: true, identity: email } : { key, saved: false },
      );
      const managedList = managedStates.map(({ key, saved }) => ({
        key,
        saved,
        managed: true,
      }));
      return { status: 200, body: JSON.stringify([...userList, ...identityList, ...managedList]) };
    } catch (err) {
      log?.warn('ghost secrets 状态回查失败', { ghostId, err: String(err) });
      return { status: 500 };
    }
  }

  // /secrets/<key>:key 段不再有子路径(带斜杠 = 非法形态,统一 404)。
  const secretKey = pathname.slice('/secrets/'.length);
  if (!secretKey || secretKey.includes('/')) return { status: 404 };
  // 身份凭证不可配置:任何写/删/读单条的动作统一 405(派生值随登录态走)。
  if (identityKeys.includes(secretKey) || managedKeys.includes(secretKey)) return { status: 405 };
  // 只认当前清单里 user 来源的键——未声明/已下线的键统一 404,不给沙箱区分面。
  if (!userSecretKeys.includes(secretKey)) return { status: 404 };

  if (method === 'PUT' || method === 'POST') {
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
    const value =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { value?: unknown }).value
        : undefined;
    if (typeof value !== 'string' || value.trim().length === 0) return { status: 400 };
    if (value.length > GHOST_SECRET_VALUE_MAX_CHARS) return { status: 413 };
    try {
      if (!vault.store(ghostId, secretKey, value.trim())) return { status: 500 };
    } catch (err) {
      log?.warn('ghost secret 入库意外失败', { ghostId, secretKey, err: String(err) });
      return { status: 500 };
    }
    // 通知钩子在入库成功之外单独兜:提示挂了不能把真成功折叠成 500。
    try {
      args.onStored?.(secretKey);
    } catch (err) {
      log?.warn('ghost secret onStored 通知失败(不影响入库结果)', {
        ghostId,
        secretKey,
        err: String(err),
      });
    }
    return { status: 204 };
  }

  if (method === 'DELETE') {
    try {
      vault.remove(ghostId, secretKey);
      return { status: 204 };
    } catch (err) {
      log?.warn('ghost secret 清除意外失败', { ghostId, secretKey, err: String(err) });
      return { status: 500 };
    }
  }

  return { status: 405 };
}
