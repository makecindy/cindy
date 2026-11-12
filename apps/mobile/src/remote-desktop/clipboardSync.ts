import {
  ClipboardSync as SharedClipboardSync,
  parseClipboardContent,
  type ClipboardSyncDeps as SharedClipboardSyncDeps,
  type ClipboardSyncBaseline,
} from "@cindy/device-link";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
export type {
  ClipboardSyncBaseline,
  LocalClipboardReadCache,
} from "@cindy/device-link";
export type ClipboardSyncDeps = Omit<SharedClipboardSyncDeps, "digest">;
export function clipboardDigest(json: string): string {
  const content = parseClipboardContent(json);
  return bytesToHex(
    sha256(
      JSON.stringify([
        content.text,
        content.html,
        content.rtf,
        content.url,
        content.png,
      ]),
    ),
  );
}
export class ClipboardSync extends SharedClipboardSync {
  constructor(deps: ClipboardSyncDeps, baseline?: ClipboardSyncBaseline) {
    super({ ...deps, digest: clipboardDigest }, baseline);
  }
}
