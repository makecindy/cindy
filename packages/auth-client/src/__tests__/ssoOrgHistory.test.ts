import { describe, expect, it } from "vitest";

import {
  MAX_SSO_ORG_HISTORY_ENTRIES,
  MAX_SSO_ORG_IDENTIFIER_LENGTH,
  parseSsoOrgHistory,
  rememberSsoOrgIdentifier,
  serializeSsoOrgHistory,
} from "../index.js";

describe("SSO organization history", () => {
  it("parses a valid versioned record and rejects malformed input", () => {
    expect(
      parseSsoOrgHistory(
        JSON.stringify({
          version: 1,
          entries: [" Example-Corp ", "", 42, "example.com"],
        }),
      ),
    ).toEqual(["Example-Corp", "example.com"]);
    expect(parseSsoOrgHistory("{")).toEqual([]);
    expect(
      parseSsoOrgHistory(JSON.stringify({ version: 2, entries: ["corp"] })),
    ).toEqual([]);
    expect(parseSsoOrgHistory(JSON.stringify(["corp"]))).toEqual([]);
  });

  it("deduplicates case-insensitively while preserving the newest display value", () => {
    expect(
      rememberSsoOrgIdentifier(
        ["Example-Corp", "other.example"],
        " example-corp ",
      ),
    ).toEqual(["example-corp", "other.example"]);
  });

  it("moves reused entries to the MRU head and caps the list", () => {
    let history: string[] = [];
    for (let index = 0; index < MAX_SSO_ORG_HISTORY_ENTRIES + 2; index += 1) {
      history = rememberSsoOrgIdentifier(history, `corp-${index}`);
    }
    expect(history).toHaveLength(MAX_SSO_ORG_HISTORY_ENTRIES);
    expect(history[0]).toBe(`corp-${MAX_SSO_ORG_HISTORY_ENTRIES + 1}`);
    expect(history).not.toContain("corp-0");

    expect(rememberSsoOrgIdentifier(history, history[2])).toEqual([
      history[2],
      history[0],
      history[1],
      ...history.slice(3),
    ]);
  });

  it("drops empty and overlong identifiers during writes and serialization", () => {
    const overlong = "x".repeat(MAX_SSO_ORG_IDENTIFIER_LENGTH + 1);
    expect(rememberSsoOrgIdentifier(["corp"], "   ")).toEqual(["corp"]);
    expect(rememberSsoOrgIdentifier(["corp"], overlong)).toEqual(["corp"]);
    expect(
      parseSsoOrgHistory(serializeSsoOrgHistory(["corp", overlong, "CORP"])),
    ).toEqual(["corp"]);
  });
});
