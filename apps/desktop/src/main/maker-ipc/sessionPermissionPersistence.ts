import { getDbClient } from '../localDb/client/current.js';
import { createSessionPermissionPersistence } from '@cindy/app-runtime/sessionPermissionPersistence';
export * from '@cindy/app-runtime/sessionPermissionPersistence';
export const { persistPermissionModeWithoutRuntime } = createSessionPermissionPersistence(getDbClient);
