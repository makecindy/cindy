import type { RemoteSerializedAttachment } from '@/session/types';
import { effectiveUploadMimeType, extractRemoteFileExt } from '@/session/attachments';
import type { MobileAttachmentUploadCandidate } from '@/session/mobileAttachmentUpload';
import type { ChatRequest } from './chatServerClient';
import { chatHttpsUrl, chatId } from './chatServerClient';

/** Existing Chat Server media contract. Signed URLs stay in memory and receive no account token. */
export function createChatServerUpload(deps: {
  request: ChatRequest;
  current(): boolean;
  operationId(): string;
  put(url: string, uri: string, mimeType: string, signal?: AbortSignal): Promise<void>;
}) {
  return async (roomId: string, candidate: MobileAttachmentUploadCandidate, uri: string,
    signal?: AbortSignal): Promise<RemoteSerializedAttachment> => {
    const check = () => {
      if (!deps.current()) throw new Error('OWNER_CHANGED');
      if (signal?.aborted) throw new Error('UPLOAD_CANCELLED');
    };
    check();
    if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) throw new Error('ATTACHMENT_UNAVAILABLE');
    if (candidate.size > 100 * 1024 * 1024) throw new Error('ATTACHMENT_TOO_LARGE');
    const room = chatId(roomId);
    const type = effectiveUploadMimeType(candidate.mimeType);
    const upload = await deps.request<{ id: string; uploadUrl: string }>(`/conversations/${room}/media`, 'POST', {
      operationId: `media:${deps.operationId()}`, name: candidate.name, type, size: candidate.size,
    });
    check();
    const id = chatId(upload.id);
    await deps.put(chatHttpsUrl(upload.uploadUrl), uri, type, signal);
    check();
    await deps.request(`/conversations/${room}/media/${id}/complete`, 'POST', { operationId: `seal:${id}` });
    check();
    // No computer/relay reference: abandoned media follows the server's media lifecycle.
    return { id, name: candidate.name, category: type.startsWith('image/') ? 'image' : 'file',
      mimeType: type, size: candidate.size, path: '', ext: extractRemoteFileExt(candidate.name) };
  };
}
