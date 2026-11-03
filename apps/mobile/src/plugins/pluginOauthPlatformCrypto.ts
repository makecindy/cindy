import {
  AESSealedData,
  AESEncryptionKey,
  aesEncryptAsync,
  aesDecryptAsync,
  getRandomBytes,
} from "expo-crypto";
import type { PluginOauthCrypto } from "./pluginOauthCrypto";
/** Uses the already-installed Expo AES module; no secret reaches an author WebView. */
export const pluginOauthPlatformCrypto: PluginOauthCrypto = {
  random: getRandomBytes,
  encrypt: async (bytes, iv, body, aad) => {
    const key = await AESEncryptionKey.import(bytes);
    const sealed = await aesEncryptAsync(body, key, {
      nonce: { bytes: iv },
      additionalData: aad,
      tagLength: 16,
    });
    return sealed.combined();
  },
  decrypt: async (bytes, combined, aad) => {
    const key = await AESEncryptionKey.import(bytes);
    return aesDecryptAsync(
      AESSealedData.fromCombined(combined, { ivLength: 12, tagLength: 16 }),
      key,
      { additionalData: aad },
    );
  },
};
