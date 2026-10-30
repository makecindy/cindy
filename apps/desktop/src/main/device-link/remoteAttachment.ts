import {
  isAttachmentOssRef,
  parseAttachmentOssRef,
  isPeerAttachmentRef,
  parsePeerAttachmentRef,
  type AttachmentIntegrity,
  type AttachmentOssRef,
  type PeerAttachment,
} from '@cindy/device-link';
import { downloadToFile } from './mediaTransfer';
import { copyPeerAttachment } from './peerAttachmentStore';

export type RemoteAttachment = AttachmentOssRef & { peer?: PeerAttachment };
export const isRemoteAttachmentRef = (value: unknown): value is string =>
  isAttachmentOssRef(value) || isPeerAttachmentRef(value);
export function parseRemoteAttachmentRef(value: string): RemoteAttachment | null {
  if (!isPeerAttachmentRef(value)) return parseAttachmentOssRef(value);
  const peer = parsePeerAttachmentRef(value);
  return peer ? { ...peer, ossKey: '', peer } : null;
}
export async function materializeRemoteAttachment(
  ref: RemoteAttachment,
  destination: string,
  integrity?: AttachmentIntegrity,
) {
  if (ref.peer) await copyPeerAttachment(ref.peer, destination);
  else await downloadToFile(ref.ossKey, destination, integrity);
}
