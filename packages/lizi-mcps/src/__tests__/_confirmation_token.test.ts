import { describe, expect, it } from "vitest";

import {
  decodeConfirmationToken,
  encodeConfirmationToken,
} from "../xdt-helper/_confirmation_token.js";

describe("confirmation token", () => {
  it("round-trips a payload when validation succeeds", () => {
    const payload = { v: 1, changes: ["session-1"] };
    const token = encodeConfirmationToken('unit_test', payload);

    expect(
      decodeConfirmationToken('unit_test', token, (value): value is typeof payload => {
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
    const token = encodeConfirmationToken('unit_test', { v: 1 });
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    expect(
      decodeConfirmationToken('unit_test', 
        tampered,
        (_value): _value is { v: number } => true,
      ),
    ).toBeNull();
  });

  it("returns null when validation rejects the payload", () => {
    const token = encodeConfirmationToken('unit_test', { v: 1 });

    expect(
      decodeConfirmationToken('unit_test', token, (_value): _value is { v: 2 } => false),
    ).toBeNull();
  });
});

describe('confirmation token purpose binding', () => {
  it('rejects a token issued for another tool even with an identical payload', () => {
    const token = encodeConfirmationToken('rename_sessions', { v: 1, ids: ['a'] });
    const isPayload = (p: unknown): p is { v: 1; ids: string[] } =>
      !!p && typeof p === 'object' && (p as { v?: unknown }).v === 1;
    expect(decodeConfirmationToken('rename_sessions', token, isPayload)).toEqual({ v: 1, ids: ['a'] });
    expect(decodeConfirmationToken('delete_sessions', token, isPayload)).toBeNull();
  });

  it('refuses malformed purposes', () => {
    expect(() => encodeConfirmationToken('bad purpose', {})).toThrow();
  });
});
