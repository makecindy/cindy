import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createChatServerWorkspaces } from '@cindy/app-runtime/chatServerWorkspaces';
export const chatServerWorkspaces = createChatServerWorkspaces(ownerScopedUserDataPath);
