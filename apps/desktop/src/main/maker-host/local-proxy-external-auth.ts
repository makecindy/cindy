/**
 * 对外模型代理(给用户自己的 CLI 用)的**对外访问 token** 鉴权。
 *
 * loopback 不是鉴权边界 —— 本机任何进程都能连上代理端口,而它背后是用户配好的付费
 * 供应商凭证。因此外部客户端必须携带一个 Cindy 生成的 token 才能被放行。token 存
 * safeStorage(跨重启稳定),校验用 `timingSafeEqual`(先比长度),范式与
 * `pi-proxy-session-auth.ts` 一致。
 *
 * 两族独立(第三期):
 *   - **A 族 = Anthropic(Claude Code)**:token 经 `ANTHROPIC_API_KEY` 传入(请求头
 *     `x-api-key`),开关是 `enabled`。
 *   - **B 族 = Codex / 通用 OpenAI**:token 经 `OPENAI_API_KEY` 传入(请求头
 *     `Authorization: Bearer`),开关是 `codexEnabled`,独立一份 token。
 * 每族各自开关、各自 token,**跨族 token 不互通** —— 各 host 只认自己族的 token,命中失败
 * 即非本族外部客户端。这比共享 token 更收紧隔离。
 *
 * 关键安全语义(勿改):
 *   - 「一个请求是不是(本族)外部客户端」= 它带的凭据是否**命中本族已存 token**,与 enabled
 *     无关。命中即判定外部客户端,强制走外部路由分支或(服务关闭时)直接 401 —— 绝不让
 *     一个携带对外 token 的请求回落到 Cindy 默认网关/订阅路由(否则 token 会被当成
 *     gateway 的 key 透传上游,造成凭证泄漏/误计费)。
 *   - token 只以掩码形式给 renderer;明文只在 main 侧鉴权与「复制/写入 env」时使用。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  readLocalProxyExternalToken,
  writeLocalProxyExternalToken,
  readLocalProxyCodexExternalToken,
  writeLocalProxyCodexExternalToken,
} from '../secrets/providerSecretStore.js';
import {
  isExternalAccessEnabled as isAnthropicEnabledFromStore,
  isCodexExternalAccessEnabled as isCodexEnabledFromStore,
} from './local-proxy-settings-store.js';

/** token 前缀:便于用户/日志一眼认出这是 Cindy 本地代理的对外 token,而非真供应商 key。 */
const TOKEN_PREFIX = 'cindy-local-';

function generateTokenValue(): string {
  // 32 字节 → base64url,足够抗猜测;不含 `+/=`,可安全放进 env / header。
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** 一族 token 的存取 + 开关读取器。A / B 族各注入自己的一套,核心逻辑完全共享。 */
interface TokenFamily {
  read: () => string | null;
  write: (value: string) => boolean;
  isEnabled: () => boolean;
}

function hasToken(family: TokenFamily): boolean {
  return family.read() !== null;
}

/**
 * 读取现有 token;不存在则生成并落盘后返回。开启对外服务 / 展示 env 时用来确保有 token。
 * safeStorage 不可用导致写失败时,返回内存里刚生成的值(本次进程内可用),不静默吞掉。
 */
function getOrCreateToken(family: TokenFamily): string {
  const existing = family.read();
  if (existing) return existing;
  const next = generateTokenValue();
  family.write(next);
  return next;
}

/** 重新生成并覆盖 token(旧 token 立即失效);返回新 token 明文。 */
function regenerateToken(family: TokenFamily): string {
  const next = generateTokenValue();
  family.write(next);
  return next;
}

/**
 * 掩码后的 token,供 UI 展示(永不把明文交给 renderer)。保留前缀 + 末 4 位,
 * 中间用固定长度的 `•`,不泄漏真实长度。无 token 时返回 null。
 */
function getTokenMasked(family: TokenFamily): string | null {
  const token = family.read();
  if (!token) return null;
  const tail = token.slice(-4);
  return `${TOKEN_PREFIX}••••••••${tail}`;
}

/**
 * 候选 token 是否命中本族已存 token。timingSafeEqual 前先比长度(长度不等直接判否,
 * 且长度信息本身不算敏感)。无已存 token / 候选为空 → 一律否。**与 enabled 无关**:
 * 调用方据此判定「是不是外部客户端」,再结合 enabled 决定放行还是 401。
 */
function matchesToken(family: TokenFamily, candidate: string | null | undefined): boolean {
  const expected = family.read();
  if (!expected || !candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}

// ─────────────── A 族:Anthropic(Claude Code)—— 签名保持不变 ───────────────

const anthropicFamily: TokenFamily = {
  read: readLocalProxyExternalToken,
  write: writeLocalProxyExternalToken,
  isEnabled: isAnthropicEnabledFromStore,
};

/** 本机是否已生成过 A 族对外 token。 */
export function hasExternalToken(): boolean {
  return hasToken(anthropicFamily);
}

export function getOrCreateExternalToken(): string {
  return getOrCreateToken(anthropicFamily);
}

export function regenerateExternalToken(): string {
  return regenerateToken(anthropicFamily);
}

export function getExternalTokenMasked(): string | null {
  return getTokenMasked(anthropicFamily);
}

export function matchesExternalToken(candidate: string | null | undefined): boolean {
  return matchesToken(anthropicFamily, candidate);
}

/** A 族对外服务是否已开启(来自非密钥设置存储)。 */
export function isExternalAccessEnabled(): boolean {
  return anthropicFamily.isEnabled();
}

// ─────────────── B 族:Codex / 通用 OpenAI —— 独立一份 token ───────────────

const codexFamily: TokenFamily = {
  read: readLocalProxyCodexExternalToken,
  write: writeLocalProxyCodexExternalToken,
  isEnabled: isCodexEnabledFromStore,
};

/** 本机是否已生成过 B 族对外 token。 */
export function hasCodexExternalToken(): boolean {
  return hasToken(codexFamily);
}

export function getOrCreateCodexExternalToken(): string {
  return getOrCreateToken(codexFamily);
}

export function regenerateCodexExternalToken(): string {
  return regenerateToken(codexFamily);
}

export function getCodexExternalTokenMasked(): string | null {
  return getTokenMasked(codexFamily);
}

export function matchesCodexExternalToken(candidate: string | null | undefined): boolean {
  return matchesToken(codexFamily, candidate);
}

/** B 族对外服务是否已开启(来自非密钥设置存储)。 */
export function isCodexExternalAccessEnabled(): boolean {
  return codexFamily.isEnabled();
}
