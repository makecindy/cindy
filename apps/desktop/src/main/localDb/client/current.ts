import { createCurrentDbClient } from '@cindy/runtime-db/client/current';
export type { CurrentDbClientSnapshot } from '@cindy/runtime-db/client/current';
export const { setCurrentDbClient, clearCurrentDbClient, getDbClient, isDbClientNotReadyError, tryGetDbClient, getCurrentDbClientUserId, getCurrentDbClientSnapshot } = createCurrentDbClient();
