import { describe, expect, it } from "vitest";
import { REMOTE_INVOKE_ALLOWLIST } from "../allowlist.js";
import { parsePluginOauthRequest } from "../pluginOauth.js";
import {
  PLUGIN_SECRET_LOCAL_CHANNEL,
  parsePluginSecretOffer,
  parsePluginSecretPresentation,
  parsePluginSecretInput,
  parsePluginSecretValue,
} from "../pluginSecretSubmission.js";

const presentation = {
  ghostName: "Demo",
  title: "Configure",
  description: "Enter API key",
  intro: "",
  fieldLabel: "API key",
  fieldDescription: "",
  maxLength: 200,
};
const state = "s".repeat(43);
describe("dedicated private secret input schema", () => {
  it("is not a generic remotely invokable channel and requires explicit capability negotiation", () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(PLUGIN_SECRET_LOCAL_CHANNEL)).toBe(
      false,
    );
    const start = {
      op: "start",
      requestId: "card",
      actionId: "action",
      expectedRevision: 0,
      publicKey: "k".repeat(59),
    };
    expect(
      parsePluginOauthRequest({ ...start, secretSubmission: true }),
    ).toMatchObject({ secretSubmission: true });
    expect(
      parsePluginOauthRequest({ ...start, secretSubmission: false }),
    ).toBeNull();
  });
  it("binds the full displayed field but never accepts a caller-supplied storage key or path", () => {
    expect(
      parsePluginSecretOffer({ kind: "secret-entry", state, presentation }),
    ).toEqual({ kind: "secret-entry", state, presentation });
    for (const extra of [
      { storageKey: "another" },
      { path: "/tmp/other" },
      { token: "synthetic" },
    ]) {
      expect(() =>
        parsePluginSecretOffer({
          kind: "secret-entry",
          state,
          presentation,
          ...extra,
        }),
      ).toThrow();
      expect(() =>
        parsePluginSecretValue({
          kind: "secret-value",
          state,
          value: "synthetic",
          ...extra,
        }),
      ).toThrow();
    }
    for (const invalid of [
      { ...presentation, title: undefined },
      { ...presentation, maxLength: 4097 },
      { ...presentation, fieldLabel: "" },
      { ...presentation, maxLength: 0 },
      { ...presentation, command: "ignored" },
    ])
      expect(() => parsePluginSecretPresentation(invalid)).toThrow();
  });
  it.each(["", " ", "x".repeat(4097), "null\u0000byte"])(
    "rejects malformed values without echoing input",
    (value) => {
      expect(() => parsePluginSecretInput(value)).toThrow(
        "PLUGIN_SECRET_UNAVAILABLE",
      );
      try {
        parsePluginSecretValue({ kind: "secret-value", state, value });
        throw new Error("accepted");
      } catch (error) {
        expect((error as Error).message).toBe("PLUGIN_SECRET_UNAVAILABLE");
      }
    },
  );
  it("preserves accepted input exactly and validates it without a transaction state", () => {
    const value = " synthetic-pat\twith whitespace ";
    expect(parsePluginSecretInput(value)).toBe(value);
    expect(
      parsePluginSecretValue({ kind: "secret-value", state, value }).value,
    ).toBe(value);
    for (const invalid of [null, undefined, 1, {}, []])
      expect(() => parsePluginSecretInput(invalid)).toThrow(
        "PLUGIN_SECRET_UNAVAILABLE",
      );
  });
});
