import { matchesGhostHostUiAttachment } from '@cindy/plugin-protocol';
import type { AttachedFile } from '@/lib/fileTypes';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { makerChatStore } from '@/lib/makerChatStore';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';
import type { PluginUiAttachmentResult } from '../../shared/pluginUi';
import { ghostInstallApprovalToken, GHOST_HANDOFF_MAX_BYTES_PER_FILE } from '../../shared/ghost';
import { readPluginUiEntries } from './PluginUiContributions';

/** Runs only from a user's add event; no subscription or input listener exists. */
export async function processPluginUiAttachment(file: AttachedFile, sessionId: string | null, signal: AbortSignal,
  readBytes: () => Promise<Uint8Array>, current: () => boolean): Promise<PluginUiAttachmentResult | null> {
  const entries = readPluginUiEntries('composer.attachment');
  if (!entries.length || sessionId && (getStickySessionDeviceId(sessionId) || makerChatStore.getSnapshot(sessionId).remoteHostId)) return null;
  for (const entry of entries) {
    if (signal.aborted || !current()) return null;
    if (!matchesGhostHostUiAttachment(entry.contribution.accept, file)) continue;
    if (file.size < 1 || file.size > GHOST_HANDOFF_MAX_BYTES_PER_FILE) throw new Error('MCP_APP_INVALID_REQUEST');
    const bytes = await readBytes();
    if (signal.aborted || !current()) return null;
    if (bytes.byteLength !== file.size) throw new Error('MCP_APP_INVALID_REQUEST');
    const requestId = crypto.randomUUID();
    const cancel = () => { void window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action-cancel', requestId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action', instanceId: entry.instanceId,
        id: entry.contribution.id, requestId, input: { attachment: { name: file.name, bytes, size: file.size, mimeType: file.mimeType } } }) as PluginUiAttachmentResult;
      // Roster broadcasts recreate entries without changing the approved provider.
      if (signal.aborted || !current() || !readPluginUiEntries('composer.attachment').some(candidate =>
        candidate.instanceId === entry.instanceId && candidate.contribution.id === entry.contribution.id &&
        candidate.ghost.dir === entry.ghost.dir &&
        ghostInstallApprovalToken(candidate.ghost.approval) === ghostInstallApprovalToken(entry.ghost.approval) &&
        JSON.stringify(candidate.contribution) === JSON.stringify(entry.contribution))) {
        if (result?.files) cleanupStagedChatAttachmentFiles(result.files);
        return null;
      }
      if (result?.handled) return result;
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return null;
}
