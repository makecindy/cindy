import { randomUUID } from 'node:crypto';
import { ModerationClient, type ModerationDecision } from './client.js';
import {
  getModerationIdentity,
  isModerationIdentityCurrent,
} from './identity.js';

const TEXT_DEADLINE_MS = 5_000;
const IMAGE_DEADLINE_MS = 10_000;

export interface ProfileModerationInput {
  displayName?: string;
  avatar?: {
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  };
}

export type ProfileModerationResult = 'allow' | 'reject' | 'cancelled';

export async function moderateProfileUpdate(
  input: ProfileModerationInput,
  client = new ModerationClient(),
): Promise<ProfileModerationResult> {
  const identity = getModerationIdentity();
  if (!identity) return 'allow';

  const operationId = randomUUID();
  const reviews: Promise<ModerationDecision>[] = [];

  if (input.displayName) {
    reviews.push(client.review({
      signBaseUrl: identity.signBaseUrl,
      accessToken: identity.accessToken,
      membershipId: identity.membershipId,
      businessCode: 'maker-nickname',
      dataId: `nickname:${identity.membershipId}:${operationId}`,
      items: [{
        type: 'TEXT',
        data: input.displayName,
        content_id: `${operationId}:nickname`,
      }],
      extra: { scene: 'profile' },
      deadlineMs: TEXT_DEADLINE_MS,
    }));
  }

  if (input.avatar) {
    const deadlineAt = Date.now() + IMAGE_DEADLINE_MS;
    const avatarUrl = await client.uploadImageBytes({
      signBaseUrl: identity.signBaseUrl,
      accessToken: identity.accessToken,
      bytes: input.avatar.bytes,
      fileName: input.avatar.fileName,
      mimeType: input.avatar.mimeType,
      deadlineAt,
    });
    if (avatarUrl) reviews.push(client.review({
        signBaseUrl: identity.signBaseUrl,
        accessToken: identity.accessToken,
        membershipId: identity.membershipId,
        businessCode: 'maker-avatar',
        dataId: `avatar:${identity.membershipId}:${operationId}`,
        items: [{
          type: 'IMAGE',
          data: avatarUrl,
          content_id: `${operationId}:avatar`,
        }],
        extra: { scene: 'profile' },
        deadlineMs: Math.max(0, deadlineAt - Date.now()),
      }));
  }

  const decisions = await Promise.all(reviews);
  if (!isModerationIdentityCurrent(identity)) return 'cancelled';
  if (decisions.includes('reject')) return 'reject';
  if (decisions.includes('cancelled')) return 'cancelled';
  return 'allow';
}
