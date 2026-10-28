import { describe, expect, it } from "vitest";
import { parsePluginOauthRequest } from "../pluginOauth.js";
import {
  parsePluginSettingsRequest,
  type PluginSettingsCommand,
} from "../pluginSettings.js";

const request = (command: unknown) => ({
  op: "settings",
  id: "page-1",
  command,
});
describe("sealed original settings commands", () => {
  it.each<PluginSettingsCommand>([
    { kind: "fetch", path: "/kv", method: "GET" },
    {
      kind: "fetch",
      path: "/secrets/key",
      method: "PUT",
      body: '{"value":"fixture"}',
    },
    { kind: "asset", path: "settings.html", offset: 0 },
    { kind: "subscribe", channels: ["one", "two:settings"] },
    { kind: "unsubscribe", channel: "one" },
    { kind: "post", channel: "one", data: { type: "status" } },
    { kind: "poll", after: 0 },
    { kind: "confirm", requestId: "confirm-1", accepted: true },
    { kind: 'answer-model-picker', requestId: 'model-1', route: null },
    { kind: 'answer-model-picker', requestId: 'model-1', route: {
      agentKind: 'codex', providerId: 'provider', model: 'model', effort: 'high', fastMode: 'ultrafast',
    } },
    {
      kind: "answer-directory",
      requestId: "directory-1",
      path: "/target/folder",
    },
    { kind: "authorize", path: "/oauth/account/connect" },
    { kind: "authorization-result", requestId: "authorization-1" },
    { kind: "document", epoch: 1 },
    { kind: "close" },
  ])("parses the settings envelope for $kind", (command) => {
    expect(parsePluginSettingsRequest(request(command))).toEqual(
      request(command),
    );
    expect(parsePluginOauthRequest(request(command))).toEqual(request(command));
  });
  it("bounds UTF-8 request bodies and serialized channel data before dispatch", () => {
    const command = {
      kind: "fetch",
      path: "/kv",
      method: "PUT",
      body: "é".repeat(32_768),
    };
    expect(parsePluginSettingsRequest(request(command))).not.toBeNull();
    expect(
      parsePluginSettingsRequest(
        request({ ...command, body: command.body + "x" }),
      ),
    ).toBeNull();
    expect(
      parsePluginSettingsRequest(
        request({ kind: "post", channel: "one", data: "x".repeat(49_152) }),
      ),
    ).toBeNull();
  });
  it.each([
    { kind: "fetch", path: "/kv", method: "PATCH" },
    { kind: "fetch", path: "/kv", method: "GET", token: "unexpected" },
    { kind: "asset", path: "settings.html", offset: -1 },
    {
      kind: "subscribe",
      channels: Array.from({ length: 17 }, (_, index) => "channel-" + index),
    },
    { kind: "post", channel: "unsafe/channel", data: {} },
    { kind: "poll", after: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "confirm", requestId: "confirm-1", accepted: "yes" },
    { kind: 'answer-model-picker', requestId: 'model-1', route: { model: 'partial' } },
    { kind: 'answer-model-picker', requestId: 'model-1', route: {
      agentKind: 'codex', providerId: 'provider', model: 'model', effort: 'high', fastMode: false, apiKey: 'private',
    } },
    { kind: "answer-directory", requestId: "directory-1", path: 42 },
    { kind: "authorization-result", requestId: "../elsewhere" },
    { kind: "close", path: "/kv" },
    { kind: "document", epoch: 0 },
    { kind: "document", epoch: 1.5 },
    { kind: "document", epoch: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "document", epoch: 1, sourceId: "forged" },
    { kind: "unknown" },
  ])("rejects malformed or ambiguous $kind commands", (command) => {
    expect(parsePluginSettingsRequest(request(command))).toBeNull();
  });
  it("rejects foreign envelope fields and page identities", () => {
    expect(
      parsePluginSettingsRequest({
        ...request({ kind: "close" }),
        id: "p".repeat(129),
      }),
    ).toBeNull();
    expect(
      parsePluginSettingsRequest({
        ...request({ kind: "close" }),
        token: "unexpected",
      }),
    ).toBeNull();
  });
});
