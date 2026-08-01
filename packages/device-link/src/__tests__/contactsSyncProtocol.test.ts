import { describe, expect, it } from "vitest";

import {
  CONTACTS_SYNC_WIRE_VERSION,
  DL_CONTACTS_SYNC_CHANNEL,
  isContactsSyncWireFrame,
} from "../contactsSyncProtocol.js";

const publicKey = `${"A".repeat(59)}=`;

describe("contacts sync protocol", () => {
  it("pins the channel/version and accepts bounded key/cipher payloads", () => {
    expect(DL_CONTACTS_SYNC_CHANNEL).toBe("device-link:contacts:sync:v1");
    expect(CONTACTS_SYNC_WIRE_VERSION).toBe(1);
    expect(
      isContactsSyncWireFrame({ version: 1, type: "key", publicKey }),
    ).toBe(true);
    expect(
      isContactsSyncWireFrame({
        version: 1,
        type: "cipher-chunk",
        senderPublicKey: publicKey,
        transferId: "transfer-1",
        index: 0,
        total: 1,
        iv: "iv",
        tag: "tag",
        compression: "gzip",
        data: "eA==",
      }),
    ).toBe(true);
  });

  it("rejects malformed keys and out-of-bounds chunk metadata", () => {
    expect(
      isContactsSyncWireFrame({
        version: 1,
        type: "key",
        publicKey: "not-a-key",
      }),
    ).toBe(false);
    expect(
      isContactsSyncWireFrame({
        version: 1,
        type: "cipher-chunk",
        senderPublicKey: publicKey,
        transferId: "transfer-1",
        index: 1,
        total: 1,
        iv: "iv",
        tag: "tag",
        compression: "gzip",
        data: "eA==",
      }),
    ).toBe(false);
  });
});
