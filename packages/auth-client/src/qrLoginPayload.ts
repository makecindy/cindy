import { z } from "zod";
import { authRegionSchema, type AuthRegion } from "./types.js";

/**
 * 扫码登录二维码内容（桌面端出码、手机端解码共用）。只有一个方向：已登录的电脑出码，
 * 未登录的手机扫码认领，电脑允许后手机登录同一个账号。
 *
 * 二维码是一条普通 https 链接：`<官网下载页>?cindy_login=<base64url(JSON)>`。
 * - 没装 Cindy 的人用系统相机扫，直接打开电脑所属版本的下载页；
 * - Cindy App 内扫码只认带 `cindy_login` 参数的链接，从中取出电脑的版本与一次性扫码凭据。
 *
 * 内容只有随机 id、扫码凭据和设备展示名，不含账号信息；手机认领时自己生成轮询凭据，
 * 原像只留在手机进程内。
 */
export const QR_LOGIN_QUERY_PARAM = "cindy_login";

export interface QrLoginPayload {
  /** 已登录的电脑出码，手机扫码认领后由电脑允许。 */
  kind: "handoff";
  region: AuthRegion;
  id: string;
  scanToken: string;
  deviceName?: string;
  platform?: string;
}

const wireSchema = z.object({
  v: z.literal(1),
  k: z.literal("h"),
  r: authRegionSchema,
  i: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  t: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  n: z.string().max(64).optional(),
  p: z.string().max(16).optional(),
});

const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return bytes;
}

function utf8Text(bytes: number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index++]!;
    let code: number;
    if (byte < 0x80) code = byte;
    else if (byte >= 0xf0) {
      code = ((byte & 7) << 18) | ((bytes[index++]! & 63) << 12) | ((bytes[index++]! & 63) << 6) | (bytes[index++]! & 63);
    } else if (byte >= 0xe0) {
      code = ((byte & 15) << 12) | ((bytes[index++]! & 63) << 6) | (bytes[index++]! & 63);
    } else code = ((byte & 31) << 6) | (bytes[index++]! & 63);
    out += String.fromCodePoint(code);
  }
  return out;
}

// 不依赖 Buffer / btoa：同一份实现要在 Electron main 与 React Native(Hermes) 里运行。
function toBase64Url(bytes: number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += BASE64URL[c & 63];
  }
  return out;
}

function fromBase64Url(text: string): number[] | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE64URL.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/** 生成二维码链接；`downloadPageUrl` 为出码设备所属版本的官网下载页。 */
export function encodeQrLoginUrl(downloadPageUrl: string, payload: QrLoginPayload): string {
  const wire = {
    v: 1 as const,
    k: "h" as const,
    r: payload.region,
    i: payload.id,
    t: payload.scanToken,
    ...(payload.deviceName ? { n: payload.deviceName.slice(0, 64) } : {}),
    ...(payload.platform ? { p: payload.platform.slice(0, 16) } : {}),
  };
  const url = new URL(downloadPageUrl);
  url.searchParams.set(QR_LOGIN_QUERY_PARAM, toBase64Url(utf8Bytes(JSON.stringify(wire))));
  return url.toString();
}

/** 解析扫到的文本；不是 Cindy 登录二维码时返回 null（由调用方提示「不是 Cindy 登录码」）。 */
export function decodeQrLoginUrl(text: string): QrLoginPayload | null {
  let encoded: string | null;
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    encoded = url.searchParams.get(QR_LOGIN_QUERY_PARAM);
  } catch {
    return null;
  }
  if (!encoded || encoded.length > 2048) return null;
  const bytes = fromBase64Url(encoded);
  if (!bytes) return null;
  let parsed: z.infer<typeof wireSchema>;
  try {
    const result = wireSchema.safeParse(JSON.parse(utf8Text(bytes)));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  return {
    kind: "handoff",
    region: parsed.r,
    id: parsed.i,
    scanToken: parsed.t,
    ...(parsed.n ? { deviceName: parsed.n } : {}),
    ...(parsed.p ? { platform: parsed.p } : {}),
  };
}
