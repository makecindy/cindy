import { createCipheriv, createDecipheriv } from "node:crypto";
import { WechatIlinkError } from "./errors.js";

function assertKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 16) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "iLink media key must be 16 bytes.",
      false,
    );
  }
  return Buffer.from(key);
}

export function encryptAes128Ecb(
  plaintext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", assertKey(key), null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAes128Ecb(
  ciphertext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const decipher = createDecipheriv("aes-128-ecb", assertKey(key), null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function aes128EcbPaddedSize(plaintextSize: number): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new WechatIlinkError(
      "PROTOCOL_ERROR",
      "Media size must be a safe integer.",
      false,
    );
  }
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
