import { createHash, randomBytes } from "node:crypto";

import type { FetchLike } from "./apiClient.js";
import { WechatIlinkError } from "./errors.js";
import {
  aes128EcbPaddedSize,
  decryptAes128Ecb,
  encryptAes128Ecb,
} from "./mediaCrypto.js";
import type { WechatMediaRef } from "./types.js";

export const WECHAT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const WECHAT_MEDIA_CIPHERTEXT_MAX_BYTES = WECHAT_MEDIA_MAX_BYTES + 16;
const CDN_FALLBACK_ORIGIN = "https://novac2c.cdn.weixin.qq.com";

function isTencentMediaUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.port === "" || url.port === "443") &&
    (url.hostname === "weixin.qq.com" ||
      url.hostname.endsWith(".weixin.qq.com"))
  );
}

function requireTencentMediaUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      `${label} is not a valid URL.`,
      false,
    );
  }
  if (!isTencentMediaUrl(url)) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      `${label} must be a credential-free Tencent HTTPS URL.`,
      false,
    );
  }
  return url;
}

function downloadUrlFor(ref: WechatMediaRef): URL {
  if (ref.downloadUrl) {
    return requireTencentMediaUrl(ref.downloadUrl, "iLink media download URL");
  }
  if (!ref.encryptedQuery?.trim()) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media omitted its download reference.",
      false,
    );
  }
  const url = new URL("/c2c/download", CDN_FALLBACK_ORIGIN);
  url.searchParams.set("encrypted_query_param", ref.encryptedQuery);
  return url;
}

function parseAesKey(ref: WechatMediaRef): Buffer {
  if (ref.aesKeyHex && /^[0-9a-fA-F]{32}$/.test(ref.aesKeyHex)) {
    return Buffer.from(ref.aesKeyHex, "hex");
  }
  if (!ref.aesKeyBase64) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media omitted its AES key.",
      false,
    );
  }
  const decoded = Buffer.from(ref.aesKeyBase64, "base64");
  if (decoded.byteLength === 16) return decoded;
  if (
    decoded.byteLength === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new WechatIlinkError(
    "PROTOCOL_ERROR",
    "iLink media AES key has an invalid encoding.",
    false,
  );
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink media exceeded the size limit.",
      false,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WechatIlinkError(
          "BAD_RESPONSE",
          "iLink media exceeded the size limit.",
          false,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function downloadWechatMedia(
  ref: WechatMediaRef,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchImpl(downloadUrlFor(ref), {
    method: "GET",
    redirect: "manual",
    signal,
  });
  if (!response.ok || response.status < 200 || response.status >= 300) {
    throw new WechatIlinkError(
      "HTTP_ERROR",
      `iLink media download failed with HTTP ${response.status}.`,
      response.status >= 500,
    );
  }
  const encrypted = await readBoundedBytes(
    response,
    WECHAT_MEDIA_CIPHERTEXT_MAX_BYTES,
  );
  let plaintext: Uint8Array;
  try {
    plaintext = decryptAes128Ecb(encrypted, parseAesKey(ref));
  } catch (error) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media decryption failed.",
      false,
      { cause: error },
    );
  }
  if (
    plaintext.byteLength === 0 ||
    plaintext.byteLength > WECHAT_MEDIA_MAX_BYTES ||
    (ref.kind === "file" &&
      ref.byteLength !== undefined &&
      plaintext.byteLength !== ref.byteLength)
  ) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media plaintext size did not match its metadata.",
      false,
    );
  }
  if (
    ref.md5Hex &&
    createHash("md5").update(plaintext).digest("hex") !==
      ref.md5Hex.toLowerCase()
  ) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media checksum did not match its metadata.",
      false,
    );
  }
  return plaintext;
}

export interface PreparedWechatUpload {
  aesKey: Buffer;
  aesKeyHex: string;
  ciphertext: Uint8Array;
  fileKey: string;
  md5Hex: string;
}

export function prepareWechatUpload(bytes: Uint8Array): PreparedWechatUpload {
  if (bytes.byteLength === 0 || bytes.byteLength > WECHAT_MEDIA_MAX_BYTES) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "WeChat outbound media must be between 1 byte and 5 MB.",
      false,
    );
  }
  const aesKey = randomBytes(16);
  return {
    aesKey,
    aesKeyHex: aesKey.toString("hex"),
    ciphertext: encryptAes128Ecb(bytes, aesKey),
    fileKey: randomBytes(16).toString("hex"),
    md5Hex: createHash("md5").update(bytes).digest("hex"),
  };
}

export function expectedWechatCiphertextSize(bytes: number): number {
  return aes128EcbPaddedSize(bytes);
}

export async function uploadWechatCiphertext(
  args: {
    uploadFullUrl?: string;
    uploadParam?: string;
    fileKey: string;
    ciphertext: Uint8Array;
  },
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<string> {
  const rawUrl = args.uploadFullUrl?.trim();
  let url: URL;
  if (rawUrl) {
    url = requireTencentMediaUrl(rawUrl, "iLink media upload URL");
  } else if (args.uploadParam?.trim()) {
    url = new URL("/c2c/upload", CDN_FALLBACK_ORIGIN);
    url.searchParams.set("encrypted_query_param", args.uploadParam);
    url.searchParams.set("filekey", args.fileKey);
  } else {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink omitted its media upload URL.",
      true,
    );
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(args.ciphertext),
    redirect: "manual",
    signal,
  });
  if (!response.ok || response.status !== 200) {
    throw new WechatIlinkError(
      "HTTP_ERROR",
      `iLink media upload failed with HTTP ${response.status}.`,
      response.status >= 500,
    );
  }
  const downloadParam = response.headers.get("x-encrypted-param")?.trim();
  if (!downloadParam) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink media upload omitted x-encrypted-param.",
      true,
    );
  }
  return downloadParam;
}
