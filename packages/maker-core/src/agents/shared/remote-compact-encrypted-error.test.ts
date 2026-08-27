import { describe, expect, it } from "vitest";

import { isRemoteCompactEncryptedContentError } from "./remote-compact-encrypted-error.js";

const COMPACT_ENCRYPTED =
  'Error running remote compact task: { "type": "error", "error": { "type": "invalid_request_error", "code": "invalid_encrypted_content", "message": "The encrypted content cind...9ln0 could not be verified. Reason: Encrypted content could not be decrypted or parsed." } }';

describe("isRemoteCompactEncryptedContentError", () => {
  it("matches Codex remote compact 400 with invalid_encrypted_content", () => {
    expect(isRemoteCompactEncryptedContentError(COMPACT_ENCRYPTED)).toBe(true);
  });

  it("does not treat standalone encrypted-content failures as compact rollover", () => {
    expect(
      isRemoteCompactEncryptedContentError(
        "Encrypted content could not be decrypted or parsed. code=invalid_encrypted_content",
      ),
    ).toBe(false);
  });

  it("does not match other compact failures", () => {
    expect(
      isRemoteCompactEncryptedContentError(
        "Error running remote compact task: timeout",
      ),
    ).toBe(false);
  });
});
