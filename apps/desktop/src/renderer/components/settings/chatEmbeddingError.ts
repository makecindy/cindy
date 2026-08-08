import { extractIpcError } from '@/utils/ipcError';

/** Stable chat-embedding IPC errors to localized settings copy. */
export function chatEmbeddingFailureKey(error: unknown): string {
  return extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY'
    ? 'settings.chatEmbedding.toast.unavailable'
    : 'settings.chatEmbedding.toast.toggleFailed';
}
