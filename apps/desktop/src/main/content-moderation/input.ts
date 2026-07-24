import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { resolveSafe as resolveCindyMediaUrl } from '../cindy-media/blobStore.js';
import { resolveSafe as resolveLegacyImageUrl } from '../imageCacheStore.js';
import { ModerationClient, type ModerationItem } from './client.js';
import {
  getModerationIdentity,
  isModerationIdentityCurrent,
} from './identity.js';

const TEXT_DEADLINE_MS = 5_000;
const LOCAL_IMAGE_DEADLINE_MS = 10_000;

export type InputModerationResult = 'allow' | 'reject' | 'cancelled';

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function resolveManagedImagePath(value: string | undefined): string | null {
  if (!value) return null;
  try {
    if (value.startsWith('cindy-media://')) return resolveCindyMediaUrl(value).absPath;
    if (value.startsWith('xdt-image://')) return resolveLegacyImageUrl(value).absPath;
  } catch {
    return null;
  }
  return null;
}

export async function moderateAgentInput(
  sessionId: string,
  item: AgentInputQueuedMessage,
  client = new ModerationClient(),
): Promise<InputModerationResult> {
  if (item.origin?.kind === 'scheduler' || item.origin?.kind === 'orca') return 'allow';
  const identity = getModerationIdentity();
  if (!identity) return 'allow';

  const imageFiles = (item.files ?? []).filter(
    (file) => file.category === 'image' && file.ext.toLowerCase() !== '.gif',
  );
  const hasLocalImage = imageFiles.some((file) => !httpsUrl(file.url) && !httpsUrl(file.path));
  const deadlineMs = hasLocalImage ? LOCAL_IMAGE_DEADLINE_MS : TEXT_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const moderationItems: ModerationItem[] = [];
  if (item.text.length > 0) {
    moderationItems.push({
      type: 'TEXT',
      data: item.text,
      content_id: `${item.clientId}:text:0`,
    });
  }

  for (const [index, file] of imageFiles.entries()) {
    const directUrl = httpsUrl(file.url) ?? httpsUrl(file.path);
    let data = directUrl;
    if (!data && file.base64) {
      const bytes = Buffer.from(file.base64, 'base64');
      if (bytes.byteLength > 0) {
        data = await client.uploadImageBytes({
          signBaseUrl: identity.signBaseUrl,
          accessToken: identity.accessToken,
          bytes,
          fileName: file.originalName || file.name,
          mimeType: file.mimeType,
          deadlineAt,
        });
      }
    }
    if (!data) {
      // A plain path is intentional for local Desktop input and same-account,
      // explicitly enabled device-link remote control. That trust boundary
      // already permits remote file browsing and agent execution; managed
      // references remain preferred because they are path-contained.
      const filePath =
        resolveManagedImagePath(file.url)
        ?? resolveManagedImagePath(file.path)
        ?? file.path;
      data = await client.uploadLocalImage({
        signBaseUrl: identity.signBaseUrl,
        accessToken: identity.accessToken,
        filePath,
        mimeType: file.mimeType,
        deadlineAt,
      });
    }
    if (!data) continue;
    moderationItems.push({
      type: 'IMAGE',
      data,
      content_id: `${item.clientId}:image:${index}`,
    });
  }

  const decision = await client.review({
    signBaseUrl: identity.signBaseUrl,
    accessToken: identity.accessToken,
    membershipId: identity.membershipId,
    businessCode: 'maker-input-t2t',
    dataId: `input:${identity.membershipId}:${sessionId}:${item.clientId}`,
    items: moderationItems,
    extra: {
      scene: 'user',
      agentKind: item.createOpts.agentKind,
      modelId: item.model,
    },
    deadlineMs: Math.max(0, deadlineAt - Date.now()),
  });
  if (!isModerationIdentityCurrent(identity)) return 'cancelled';
  return decision;
}
