import { describe, expect, it } from "vitest";
import {
  normalizePluginConnectionHost,
  parsePluginConnectionInput,
  parsePluginConnectionValue,
  PLUGIN_CONNECTION_LOCAL_CHANNEL,
} from "../pluginConnectionSubmission.js";
import { parsePluginOauthRequest } from "../pluginOauth.js";
import { REMOTE_INVOKE_ALLOWLIST } from "../allowlist.js";

describe("connection input wire contract", () => {
  it.each([
    "git.example.test",
    "https://GIT.example.test/",
    "https://git.example.test:443/",
  ])("accepts an exact HTTPS host: %s", (host) => {
    expect(normalizePluginConnectionHost(host)).toBe("git.example.test");
  });
  it.each([
    "http://git.example.test",
    "https://git.example.test:8443",
    "*.example.test",
    "https://git.example.test/path",
    "https://git.example.test/?token=x",
    "https://u:p@git.example.test",
    "https://git.example.test/path/..",
    "https://%67it.example.test/",
    "https://git.example.test/#fragment",
    "https://127.0.0.1",
    "https://[::1]",
    "git.example.test:443",
    "https://git.example.test\\@evil.test",
    "localhost",
  ])("rejects ambiguous target %s", (host) => {
    expect(() => normalizePluginConnectionHost(host)).toThrow();
  });
  it.each([
    "",
    "x".repeat(4097),
    "a\r\nINJECTED: header",
    "a\u0000b",
    "with space",
  ])("rejects invalid token %#", (token) => {
    expect(() =>
      parsePluginConnectionInput({ host: "git.example.test", token }),
    ).toThrow();
  });
  it("rejects unknown fields and a secret-value disguised as a connection", () => {
    expect(() =>
      parsePluginConnectionInput({
        host: "git.example.test",
        token: "synthetic",
        path: "/vault",
      }),
    ).toThrow();
    expect(() =>
      parsePluginConnectionValue({
        kind: "secret-value",
        state: "a".repeat(43),
        value: "synthetic",
      }),
    ).toThrow();
  });
  it("requires explicit additive capability and keeps the local input off the remote allowlist", () => {
    const base = {
      op: "start",
      requestId: "request",
      actionId: "connection",
      expectedRevision: 1,
      publicKey: "a".repeat(59),
    };
    expect(
      parsePluginOauthRequest({ ...base, connectionSubmission: true }),
    ).toMatchObject({ connectionSubmission: true });
    expect(
      parsePluginOauthRequest({ ...base, connectionSubmission: false }),
    ).toBeNull();
    expect(REMOTE_INVOKE_ALLOWLIST.has(PLUGIN_CONNECTION_LOCAL_CHANNEL)).toBe(
      false,
    );
  });
});
