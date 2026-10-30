/**
 * opencode-go-session —— OpenCode Go 直连请求的会话头适配。
 *
 * OpenCode Go 自 2026-09-06 起强制要求每个请求携带稳定会话标识，缺失直接 400
 * `MissingSessionID`（上游文档 https://opencode.ai/docs/go/#where-can-i-use-it）。
 *
 * 原生透传的会话路径不需要本模块：各客户端/桥自带的上游可识别头——Claude Code
 * Messages 透传的 `x-claude-code-session-id`、Codex 的 `session-id`、Pi 当前构建自己注入的
 * `x-opencode-session`，以及 Codex chat bridge 的 thread-id → x-opencode-session
 * 映射（#4073 / #4075）。本模块服务**由 host 从零构造请求头的出口**：辅助模型 one-shot、
 * 供应商「测试连接」探测、视觉桥，以及 Claude 本地供应商桥 → Pi SDK 原生适配器
 * （`createPiProviderFetch`，它重建出站请求、不继承入站头；sessionId 由桥按请求传入，#5325）。
 *
 * 路由识别有三路信号：运行时供应商 id、目录预设身份（`catalogPresetId`，从预设创建后
 * 即使把地址改成自建转发、或复制连接得到新 id 也仍保留）、上游地址。三者任一命中即视为
 * OpenCode Go：多补一个会话头对非 Go 端点无害（未知头被忽略），漏了则整条直连链路 400。
 *
 * 取值分两种：
 * - 普通直连（host 每请求发起）：随机 UUID，一次 one-shot 即一次独立对话；
 * - spawn env 注入（层 C：Pi 视觉桥 env）：必须**确定性派生**（pi-harness §4.10
 *   spawn env 稳定性）——同 sessionId + 同后端恒等，断链重连不变；用随机值会让
 *   远端 daemon 的 envHash 变化 → kill + 全新建。
 */

import { createHash, randomUUID } from 'node:crypto';

import { CONVERSATION_SESSION_HEADER } from '@cindy/responses-chat-bridge';

export interface OpenCodeGoSessionRoute {
  /** 运行时供应商 id（从预设创建时通常是预设 id，复制/改名后可不同）。 */
  providerId: string;
  /** 目录预设身份（`CatalogModel.catalogPresetId`）；存量连接可能没有。 */
  catalogPresetId?: string;
  upstream: string;
  /**
   * spawn env 注入场景传入逻辑 session id：头值按 sessionId + 后端身份确定性派生。
   * 缺省 = 每请求随机 UUID（host 直连路径）。
   */
  sessionId?: string;
}

/** OpenCode Go 预设入口：`https://opencode.ai/zen/go` 或带 `/v1`。 */
export function isOpenCodeGoUpstream(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai') return false;
  if (url.username || url.password || url.search || url.hash) return false;
  const path = url.pathname.replace(/\/+$/, '');
  return path === '/zen/go' || path === '/zen/go/v1';
}

/**
 * 按会话头名（大小写不敏感）拆分：其余头 + 首个**非空**用户值的拼写。
 *
 * 同名不同拼写一起交给 fetch 会被合并成 `', <value>'` 这类非法复合值
 * （responses-chat-bridge 同因修复）；历史配置还常留空占位值。这里一次遍历同时完成
 * 「剔除空占位」「同名只留一个」「保留用户显式值」，调用方无需再二次去重。
 */
function splitSessionHeader(headers: Record<string, string> | undefined): {
  rest: Record<string, string>;
  userKey: string | null;
  userValue: string | null;
} {
  const normalized = CONVERSATION_SESSION_HEADER.toLowerCase();
  const rest: Record<string, string> = {};
  let userKey: string | null = null;
  let userValue: string | null = null;
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== normalized) {
      rest[key] = value;
      continue;
    }
    if (userKey === null && typeof value === 'string' && value.trim()) {
      userKey = key;
      userValue = value;
    }
  }
  return { rest, userKey, userValue };
}

function stableSessionHeaderValue(route: OpenCodeGoSessionRoute, sessionId: string): string {
  return createHash('sha256')
    .update(`${sessionId}\n${route.providerId}\n${route.upstream.trim().replace(/\/+$/, '')}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 给 OpenCode Go 路由的直连请求补 `x-opencode-session`；其余路由原样返回
 * （undefined 表示本来就没有额外头）。供应商 id、目录预设身份或上游地址任一命中
 * 即视为 OpenCode Go：用户把预设改到自建转发、复制连接得到新 id 都需要该头，
 * 反向（自定义 id 指向官方入口）也要覆盖。
 *
 * 调用方已显式配置**非空**同名头（历史手工 workaround）时保留用户值，且结果里
 * 同名键只留一个——空占位 + 大小写变体的组合交给 fetch 会被合并成非法复合值。
 */
export function withOpenCodeGoSessionHeader(
  headers: Record<string, string> | undefined,
  route: OpenCodeGoSessionRoute,
): Record<string, string> | undefined {
  const isOpenCodeGo =
    route.providerId === 'opencode-go' ||
    route.catalogPresetId === 'opencode-go' ||
    isOpenCodeGoUpstream(route.upstream);
  if (!isOpenCodeGo) return headers;
  const { rest, userKey, userValue } = splitSessionHeader(headers);
  if (userKey !== null && userValue !== null) {
    return { ...rest, [userKey]: userValue };
  }
  const sessionId = route.sessionId?.trim();
  const value = sessionId ? stableSessionHeaderValue(route, sessionId) : randomUUID();
  return { ...rest, [CONVERSATION_SESSION_HEADER]: value };
}
