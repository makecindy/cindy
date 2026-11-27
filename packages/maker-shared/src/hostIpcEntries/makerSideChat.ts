import type { HostIpcEntry } from '../hostIpcRegistry.js';

/** Side chats of a task. Sorted by channel. */
export const MAKER_SIDE_CHAT_IPC: readonly HostIpcEntry[] = [
  {
    // Side-chat tabs restore from this list when a task opens.
    channel: 'maker:side-chat:list:v1',
    contractVersion: 1,
    audience: ['local'],
    access: 'read',
    sender: 'trusted-app-renderer',
    params: [{ type: 'string', nonBlank: true }],
    result: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', nonBlank: true } } } },
  },
];
