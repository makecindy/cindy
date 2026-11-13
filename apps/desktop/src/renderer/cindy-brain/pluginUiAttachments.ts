import { matchesGhostHostUiAttachment } from '@cindy/plugin-protocol';
import type { AttachedFile } from '@/lib/fileTypes';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { makerChatStore } from '@/lib/makerChatStore';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';
import type { PluginUiAttachmentResult } from '../../shared/pluginUi';
import { ghostInstallApprovalToken } from '../../shared/ghost';
import { readPluginUiEntries } from './PluginUiContributions';

/** Runs only from a user's add event; no subscription or input listener exists. */
export async function processPluginUiAttachment(file: AttachedFile, sessionId: string | null, signal: AbortSignal): Promise<PluginUiAttachmentResult | null> {
  const entries = readPluginUiEntries('composer.attachment');
  if (!entries.length || sessionId && (getStickySessionDeviceId(sessionId) || makerChatStore.getSnapshot(sessionId).remoteHostId)) return null;
  for (const entry of entries) {
    if (signal.aborted) return null;
    if (!matchesGhostHostUiAttachment(entry.contribution.accept, file)) continue;
    const requestId = crypto.randomUUID();
    const cancel = () => { void window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action-cancel', requestId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const uri = file.path.startsWith('clipboard:') ? file.url ?? `data:${file.mimeType};base64,${file.base64 ?? ''}` : file.path;
      const result = await window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action', instanceId: entry.instanceId,
        id: entry.contribution.id, requestId, input: { attachment: { name: file.name, uri, size: file.size, mimeType: file.mimeType } } }) as PluginUiAttachmentResult;
      // Roster broadcasts recreate entries without changing the approved provider.
      if (signal.aborted || !readPluginUiEntries('composer.attachment').some(current =>
        current.instanceId === entry.instanceId && current.contribution.id === entry.contribution.id &&
        current.ghost.dir === entry.ghost.dir &&
        ghostInstallApprovalToken(current.ghost.approval) === ghostInstallApprovalToken(entry.ghost.approval) &&
        JSON.stringify(current.contribution) === JSON.stringify(entry.contribution))) {
        if (result?.files) cleanupStagedChatAttachmentFiles(result.files);
        return null;
      }
      if (result?.handled) return result;
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return null;
}
