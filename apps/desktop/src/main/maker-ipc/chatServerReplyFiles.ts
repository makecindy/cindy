import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { createChatReplyFiles } from '@cindy/app-runtime/chatServerReplyFiles';
export { readReplyFile } from '@cindy/app-runtime/chatServerReplyFiles';
export const { prepareChatReplyFiles } = createChatReplyFiles({ getCurrentDbClientSnapshot });
