/**
 * Smart Contacts device-sync wire contract shared by every Device Link client.
 *
 * The relay treats push payloads as opaque, but channel names, versions and
 * bounds still belong in the shared protocol layer so another client cannot
 * accidentally implement a different frame shape.
 */

export const CONTACTS_SYNC_WIRE_VERSION = 1;
export const DL_CONTACTS_SYNC_CHANNEL = "device-link:contacts:sync:v1";

export const CONTACTS_SYNC_CHUNK_BYTES = 256 * 1024;
export const CONTACTS_SYNC_MAX_CHUNKS = 128;

export interface ContactsSyncKeyFrame {
  version: typeof CONTACTS_SYNC_WIRE_VERSION;
  type: "key";
  publicKey: string;
}

export interface ContactsSyncCipherChunkFrame {
  version: typeof CONTACTS_SYNC_WIRE_VERSION;
  type: "cipher-chunk";
  senderPublicKey: string;
  transferId: string;
  index: number;
  total: number;
  iv: string;
  tag: string;
  compression: "gzip";
  data: string;
}

export type ContactsSyncWireFrame =
  ContactsSyncKeyFrame | ContactsSyncCipherChunkFrame;

/** Protocol-level shape check. Hosts still parse the DER key before crypto use. */
export function isContactsSyncWireFrame(
  value: unknown,
): value is ContactsSyncWireFrame {
  if (!isRecord(value) || value.version !== CONTACTS_SYNC_WIRE_VERSION)
    return false;
  if (value.type === "key") return isX25519SpkiBase64Shape(value.publicKey);
  if (value.type !== "cipher-chunk") return false;
  return (
    isX25519SpkiBase64Shape(value.senderPublicKey) &&
    isBoundedText(value.transferId, 128) &&
    Number.isInteger(value.index) &&
    (value.index as number) >= 0 &&
    Number.isInteger(value.total) &&
    (value.total as number) >= 1 &&
    (value.total as number) <= CONTACTS_SYNC_MAX_CHUNKS &&
    (value.index as number) < (value.total as number) &&
    isBoundedText(value.iv, 64) &&
    isBoundedText(value.tag, 64) &&
    value.compression === "gzip" &&
    isBoundedText(
      value.data,
      Math.ceil((CONTACTS_SYNC_CHUNK_BYTES * 4) / 3) + 8,
    )
  );
}

/** Node exports an X25519 SPKI public key as 44 DER bytes = 60 base64 chars. */
function isX25519SpkiBase64Shape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 60 &&
    /^(?:[A-Za-z0-9+/]{4}){14}[A-Za-z0-9+/]{3}=$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
