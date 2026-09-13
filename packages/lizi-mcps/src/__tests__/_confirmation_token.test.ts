import { describe, expect, it } from "vitest";

import {
  decodeConfirmationToken,
  encodeConfirmationToken,
} from "../xdt-helper/_confirmation_token.js";

describe("confirmation token", () => {
  it("round-trips a payload when validation succeeds", () => {
    const payload = { v: 1, changes: ["session-1"] };
    const token = encodeConfirmationToken(payload);

    expect(
      decodeConfirmationToken(token, (value): value is typeof payload => {
        return (
          typeof value === "object" &&
          value !== null &&
          "v" in value &&
          value.v === 1 &&
          "changes" in value &&
          Array.isArray(value.changes)
        );
      }),
    ).toEqual(payload);
  });

  it("returns null when the signature is tampered with", () => {
    const token = encodeConfirmationToken({ v: 1 });
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    expect(
      decodeConfirmationToken(
        tampered,
        (_value): _value is { v: number } => true,
      ),
    ).toBeNull();
  });

  it("returns null when validation rejects the payload", () => {
    const token = encodeConfirmationToken({ v: 1 });

    expect(
      decodeConfirmationToken(token, (_value): _value is { v: 2 } => false),
    ).toBeNull();
  });
});
