import { coerceAppshotMetadata } from '../../shared/appshots.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const APPSHOT_ONLY_CODEX_ERROR = 'Appshots are only supported in Codex sessions';

type MessageBlock = { type?: unknown; appshot?: unknown; [key: string]: unknown };
export function validateAndStripAppshotMetadata(
  message: unknown,
  agentKind: 'claude-code' | 'codex' | 'pi',
): { message: unknown; hasAppshot: boolean } {
  if (
    typeof message === 'string' ||
    !message ||
    typeof message !== 'object' ||
    !('content' in message) ||
    typeof (message as { content?: unknown }).content === 'string' ||
    !Array.isArray((message as { content?: unknown }).content)
  ) {
    return { message, hasAppshot: false };
  }

  let hasAppshot = false;
  const typedMessage = message as { type?: unknown; content: MessageBlock[] };
  const content = typedMessage.content.map((block) => {
    if (!block || typeof block !== 'object' || !('appshot' in block)) return block;
    const metadata = coerceAppshotMetadata(block.appshot);
    if (!metadata) {
      const withoutMetadata = { ...block };
      delete withoutMetadata.appshot;
      return withoutMetadata;
    }
    hasAppshot = true;
    if (agentKind !== 'codex') throwIpcError('UNSUPPORTED_CAPABILITY', APPSHOT_ONLY_CODEX_ERROR);
    return { ...block, appshot: metadata };
  });
  return { message: { ...typedMessage, content }, hasAppshot };
}

export function requireCodexQueuedAppshots(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const queued = value as { createOpts?: { agentKind?: unknown }; files?: unknown };
  const files = Array.isArray(queued.files) ? queued.files : [];
  const hasAppshot = files.some((file) => {
    if (!file || typeof file !== 'object' || !('appshot' in file)) return false;
    return coerceAppshotMetadata((file as { appshot?: unknown }).appshot) !== null;
  });
  if (hasAppshot && queued.createOpts?.agentKind !== 'codex') {
    throwIpcError('UNSUPPORTED_CAPABILITY', APPSHOT_ONLY_CODEX_ERROR);
  }
}

export { APPSHOT_ONLY_CODEX_ERROR };
