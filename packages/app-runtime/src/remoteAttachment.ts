import {
  isAttachmentOssRef,
  parseAttachmentOssRef,
  isPeerAttachmentRef,
  parsePeerAttachmentRef,
  type AttachmentIntegrity,
  type AttachmentOssRef,
  type PeerAttachment,
} from "@cindy/device-link";
export type RemoteAttachment = AttachmentOssRef & { peer?: PeerAttachment };
export const isRemoteAttachmentRef = (value: unknown): value is string =>
  isAttachmentOssRef(value) || isPeerAttachmentRef(value);
export function parseRemoteAttachmentRef(
  value: string,
): RemoteAttachment | null {
  if (!isPeerAttachmentRef(value)) return parseAttachmentOssRef(value);
  const peer = parsePeerAttachmentRef(value);
  return peer ? { ...peer, ossKey: "", peer } : null;
}
export interface RemoteAttachmentHost {
  downloadToFile(
    key: string,
    destination: string,
    integrity?: AttachmentIntegrity,
  ): Promise<void>;
  copyPeerAttachment(peer: PeerAttachment, destination: string): Promise<void>;
}
export function createRemoteAttachmentMaterializer(host: RemoteAttachmentHost) {
  return async function materializeRemoteAttachment(
    ref: RemoteAttachment,
    destination: string,
    integrity?: AttachmentIntegrity,
  ) {
    if (ref.peer) await host.copyPeerAttachment(ref.peer, destination);
    else await host.downloadToFile(ref.ossKey, destination, integrity);
  };
}
