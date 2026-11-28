import * as Linking from 'expo-linking';

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

/**
 * 构建期实际注册的 scheme：CN 包是 `cindycn`，global 包是 `cindy`。
 * 共享包的 `BRAND_IDENTITY.primaryScheme` 永远是 `cindy`，不能直接当运行时值。
 */
export function desktopEntryScheme(): string {
  try {
    const match = /^([a-zA-Z][\w+.-]*):/.exec(Linking.createURL('/'));
    return match?.[1] || BRAND_IDENTITY.primaryScheme;
  } catch {
    return BRAND_IDENTITY.primaryScheme;
  }
}
