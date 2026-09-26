import { describe, expect, it } from "vitest";
import {
  parsePluginAuthorizationRequest,
  parsePluginAuthorizationOffer,
  parsePluginAuthorizationResult,
} from "../pluginAuthorization.js";
import { parsePluginOauthRequest } from "../pluginOauth.js";

function loopback() {
  const callbackUrl = "http://127.0.0.1:45678/callback";
  const state = "cli_state_0123456789";
  const url = new URL("https://provider.example/authorize");
  url.search = new URLSearchParams({
    client_id: "fixture-client",
    response_type: "code",
    state,
    redirect_uri: callbackUrl,
    code_challenge: "s".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return { kind: "loopback" as const, url: url.toString(), callbackUrl, state };
}

describe("private extensible authorization schema", () => {
  it.each(["ABCD-EFGH", "abcDEF123", "123456", "AB CD EF"])(
    "preserves a provider user code %s",
    (userCode) => {
      const request = {
        kind: "device",
        url: "https://provider.example/activate",
        userCode,
      };
      expect(parsePluginAuthorizationRequest(request)).toEqual(request);
    },
  );
  it.each(["", "a".repeat(33), "code\n", "<script>", "token=secret", "A\tB"])(
    "rejects non-display code %j",
    (userCode) => {
      expect(() =>
        parsePluginAuthorizationRequest({
          kind: "device",
          url: "https://provider.example",
          userCode,
        }),
      ).toThrow();
    },
  );
  it("accepts browser confirmation without claiming access to its cookies", () => {
    expect(
      parsePluginAuthorizationRequest({
        kind: "browser",
        url: "https://provider.example/qr?request=fixture",
      }),
    ).toMatchObject({ kind: "browser" });
    expect(() =>
      parsePluginAuthorizationRequest({
        kind: "browser",
        url: "https://provider.example",
        cookies: [],
      }),
    ).toThrow();
  });
  it.each(["command", "token", "device_code", "secret", "callbackUrl"])(
    "rejects extra device parameter %s",
    (key) => {
      expect(() =>
        parsePluginAuthorizationRequest({
          kind: "device",
          url: "https://provider.example",
          [key]: "private",
        }),
      ).toThrow();
    },
  );
  it.each([
    "http://provider.example",
    "file:///tmp",
    "https://127.0.0.1",
    "https://[::1]",
    "https://provider.example:8443",
  ])("rejects authorization URL %s", (url) => {
    expect(() =>
      parsePluginAuthorizationRequest({ kind: "browser", url }),
    ).toThrow();
  });
  it("requires exact redirect, state and S256, never implicit grants", () => {
    const valid = loopback();
    expect(parsePluginAuthorizationRequest(valid)).toEqual(valid);
    for (const [key, value] of Object.entries({
      state: "different_state_fixture",
      redirect_uri: "http://127.0.0.1:45678/other",
      response_type: "token",
      code_challenge_method: "plain",
      code_challenge: "invalid",
      client_id: "",
    })) {
      const url = new URL(valid.url);
      url.searchParams.set(key, value);
      expect(() =>
        parsePluginAuthorizationRequest({ ...valid, url: url.toString() }),
      ).toThrow();
    }
    const url = new URL(valid.url);
    url.searchParams.append("state", valid.state);
    expect(() =>
      parsePluginAuthorizationRequest({ ...valid, url: url.toString() }),
    ).toThrow();
  });
  it.each(["http://localhost:45678/cb", "http://[::1]:45678/cb"])(
    "supports literal loopback %s",
    (callbackUrl) => {
      const valid = loopback(),
        url = new URL(valid.url);
      url.searchParams.set("redirect_uri", callbackUrl);
      expect(
        parsePluginAuthorizationRequest({
          ...valid,
          url: url.toString(),
          callbackUrl,
        }),
      ).toMatchObject({ callbackUrl });
    },
  );
  it.each([
    "http://127.0.0.2:45678/cb",
    "http://internal.example:45678/cb",
    "http://127.0.0.1:80/cb",
    "http://user@127.0.0.1:45678/cb",
    "http://127.0.0.1:45678/cb?next=x",
  ])("rejects callback target %s", (callbackUrl) => {
    const valid = loopback(),
      url = new URL(valid.url);
    url.searchParams.set("redirect_uri", callbackUrl);
    expect(() =>
      parsePluginAuthorizationRequest({
        ...valid,
        url: url.toString(),
        callbackUrl,
      }),
    ).toThrow();
  });
  it("keeps bridge state separate and validates private results", () => {
    const offer = {
      kind: "authorization",
      state: "b".repeat(43),
      request: loopback(),
    };
    expect(parsePluginAuthorizationOffer(offer)).toEqual(offer);
    expect(
      parsePluginAuthorizationResult({
        kind: "callback",
        state: loopback().state,
        code: "synthetic-code",
      }),
    ).toMatchObject({ kind: "callback" });
    for (const raw of [
      { kind: "callback", state: "bad", code: "x" },
      { kind: "opened", token: "x" },
      { kind: "callback", state: loopback().state, code: "x", error: "denied" },
    ])
      expect(() => parsePluginAuthorizationResult(raw)).toThrow();
  });
  it("negotiates additively without accepting false flags or unrecognized capabilities", () => {
    const start = {
      op: "start",
      requestId: "card",
      actionId: "action",
      expectedRevision: 0,
      publicKey: "a".repeat(59),
    };
    expect(parsePluginOauthRequest(start)).toEqual(start);
    expect(
      parsePluginOauthRequest({ ...start, authorizationV1: true }),
    ).toMatchObject({ authorizationV1: true });
    expect(
      parsePluginOauthRequest({ ...start, authorizationV1: false }),
    ).toBeNull();
    expect(
      parsePluginOauthRequest({ ...start, arbitraryAdapter: true }),
    ).toBeNull();
  });
});
