import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createChatMigrationReceipts } from '@cindy/app-runtime/chatMigrationReceipts';
export const chatMigrationReceipts = createChatMigrationReceipts(ownerScopedUserDataPath);
