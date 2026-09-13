/**
 * xdt-helper/_confirmation_token.ts —— dry-run → 确认 两段式写操作共用的 token 编解码。
 *
 * 需要用户核对后才能落库的批量写(rename_sessions / delete_sessions)先返回预览与
 * 一枚 HMAC 签名的 token,真正写入时必须回传同一批变更对应的 token。密钥进程内随机,
 * token 不跨进程、不落盘,只用于防止模型跳过预览直接写。
 */

import { createHmac, randomBytes } from "node:crypto";

const CONFIRMATION_TOKEN_SECRET = randomBytes(32);

function sign(encoded: string): string {
  return createHmac("sha256", CONFIRMATION_TOKEN_SECRET)
    .update(encoded)
    .digest("hex")
    .slice(0, 24);
}

export function encodeConfirmationToken(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `v1.${encoded}.${sign(encoded)}`;
}

/**
 * 解码并校验签名;`validate` 负责结构校验,任一步失败返回 null。
 */
export function decodeConfirmationToken<T>(
  token: string,
  validate: (payload: unknown) => payload is T,
): T | null {
  const [version, encoded, digest] = token.split(".");
  if (version !== "v1" || !encoded || !digest) return null;
  if (digest !== sign(encoded)) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    return validate(payload) ? payload : null;
  } catch {
    return null;
  }
}
