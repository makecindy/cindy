/**
 * xdt-helper/_confirmation_token.ts —— dry-run → 确认 两段式写操作共用的 token 编解码。
 *
 * 需要用户核对后才能落库的批量写(rename_sessions / delete_sessions)先返回预览与
 * 一枚 HMAC 签名的 token,真正写入时必须回传同一批变更对应的 token。密钥进程内随机,
 * token 不跨进程、不落盘,只用于防止模型跳过预览直接写。
 *
 * 签名内容绑定签发工具的 `purpose`(工具名):多个工具共用同一把进程内密钥时,
 * 一个工具签发的 token 不能被另一个工具接受,即使二者 payload 形状恰好重叠。
 */

import { createHmac, randomBytes } from "node:crypto";

const CONFIRMATION_TOKEN_SECRET = randomBytes(32);

const PURPOSE_PATTERN = /^[a-z0-9_]+$/;

function sign(purpose: string, encoded: string): string {
  return createHmac("sha256", CONFIRMATION_TOKEN_SECRET)
    .update(`${purpose}.${encoded}`)
    .digest("hex")
    .slice(0, 24);
}

function assertPurpose(purpose: string): void {
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error(`invalid confirmation token purpose: ${purpose}`);
  }
}

/**
 * `purpose` 是签发工具名(如 `rename_sessions`),进入 token 正文与签名内容。
 */
export function encodeConfirmationToken(purpose: string, payload: unknown): string {
  assertPurpose(purpose);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `v1.${purpose}.${encoded}.${sign(purpose, encoded)}`;
}

/**
 * 解码并校验用途与签名;`validate` 负责结构校验,任一步失败返回 null。
 */
export function decodeConfirmationToken<T>(
  purpose: string,
  token: string,
  validate: (payload: unknown) => payload is T,
): T | null {
  assertPurpose(purpose);
  const [version, tokenPurpose, encoded, digest] = token.split(".");
  if (version !== "v1" || tokenPurpose !== purpose || !encoded || !digest) return null;
  if (digest !== sign(purpose, encoded)) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    return validate(payload) ? payload : null;
  } catch {
    return null;
  }
}
