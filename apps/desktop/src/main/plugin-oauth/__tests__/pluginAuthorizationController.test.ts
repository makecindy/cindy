// Cross-platform tests use the Node host environment; importing Desktop main
// from Mobile tests pulls Node-only APIs into the React Native type environment.
import { describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { OauthTransactions } from "../transactions";
import { getRemoteOauthContext } from "../context";
import { runMobilePluginAuthorization } from "../../../../../mobile/src/plugins/pluginAuthorizationController";
import { mobilePluginSetupActions } from "../../../../../mobile/src/plugins/pluginSetupActions";
import type { PluginOauthCrypto } from "../../../../../mobile/src/plugins/pluginOauthCrypto";
const crypto: PluginOauthCrypto = {
  random: (n) => new Uint8Array(randomBytes(n)),
  encrypt: async (key, iv, body, aad) => {
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad);
    return new Uint8Array(
      Buffer.concat([
        Buffer.from(iv),
        c.update(body),
        c.final(),
        c.getAuthTag(),
      ]),
    );
  },
  decrypt: async (key, data, aad) => {
    const c = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    c.setAAD(aad);
    c.setAuthTag(data.subarray(-16));
    return new Uint8Array(
      Buffer.concat([c.update(data.subarray(12, -16)), c.final()]),
    );
  },
};
const secretPresentation = {
  ghostName: "Practice",
  title: "Connect",
  description: "API key",
  intro: "Private account",
  fieldLabel: "Key",
  fieldDescription: "Keep private",
  maxLength: 4096,
};
const connectionPresentation = {
  ghostName: "Practice",
  title: "Connect",
  description: "Connection",
  intro: "Private account",
  connectionKey: "account",
};
const action = { requestId: "card", actionId: "connect", expectedRevision: 0 };
function setup(kind: "secret" | "connection") {
  const saved = vi.fn(),
    requests: unknown[] = [];
  const host = new OauthTransactions({
    owner: () => "account",
    available: () => true,
    bind: async () => ({ ghostId: "practice", current: () => true }),
    run: () => {
      const remote = getRemoteOauthContext()!;
      void (async () => {
        try {
          const state = randomBytes(32).toString("base64url");
          const value =
            kind === "secret"
              ? await remote.submitSecret!({
                  kind: "secret-entry",
                  state,
                  presentation: secretPresentation,
                })
              : await remote.submitConnection!({
                  kind: "connection-entry",
                  state,
                  presentation: connectionPresentation,
                });
          saved(value);
          remote.finish(true);
        } catch {
          remote.finish(false);
        }
      })();
      return true;
    },
  });
  return {
    saved,
    requests,
    invoke: async (request: Parameters<OauthTransactions["request"]>[1]) => {
      requests.push(request);
      return host.request("phone", request);
    },
  };
}
describe("native plugin configuration exchange", () => {
  it.each(["secret", "connection"] as const)(
    "saves %s only after matching the real Host offer and passes no plaintext through the tunnel",
    async (kind) => {
      const h = setup(kind),
        clear = vi.fn();
      await runMobilePluginAuthorization({
        crypto,
        action,
        kind,
        invoke: h.invoke,
        assertCurrent: () => {},
        pause: async () => {},
        clearInput: clear,
        secretPresentation,
        connectionPresentation,
        inputSecret: "fake-private-test-value",
        inputConnection: {
          host: "https://example.org",
          token: "fake-private-test-value",
        },
        showAuthorization: async () => {
          throw Error("No browser expected");
        },
      });
      expect(h.saved).toHaveBeenCalledTimes(1);
      expect(h.saved).toHaveBeenCalledWith(
        kind === "secret"
          ? "fake-private-test-value"
          : { host: "example.org", token: "fake-private-test-value" },
      );
      expect(JSON.stringify(h.requests)).not.toContain(
        "fake-private-test-value",
      );
      expect(clear).toHaveBeenCalled();
    },
  );
  it("rejects an offer that differs from the displayed form and cancels without a vault write", async () => {
    const h = setup("secret");
    await expect(
      runMobilePluginAuthorization({
        crypto,
        action,
        kind: "secret",
        invoke: h.invoke,
        assertCurrent: () => {},
        pause: async () => {},
        clearInput: () => {},
        secretPresentation: {
          ...secretPresentation,
          fieldLabel: "Another field",
        },
        inputSecret: "fake-private-test-value",
        showAuthorization: async () => {},
      }),
    ).rejects.toThrow("OAUTH_BRIDGE_UNAVAILABLE");
    expect(h.saved).not.toHaveBeenCalled();
    expect(h.requests.at(-1)).toMatchObject({ op: "cancel" });
  });
  it("projects only pending Host-enabled steps; no secret value or arbitrary setup action becomes a native capability", () => {
    const raw = {
      kind: "plugin_setup",
      requestId: "card",
      revision: 0,
      ghost: { id: "practice", name: "Practice" },
      remoteSecret: true,
      intro: "Private account",
      steps: [
        {
          id: "key",
          phase: "pending",
          title: "Connect",
          description: "API key",
          action: {
            id: "connect",
            kind: "inline_form",
            form: {
              fields: [
                {
                  label: "Key",
                  description: "Keep private",
                  maxLength: 4096,
                  value: "must never project",
                },
              ],
            },
          },
        },
      ],
    };
    expect(mobilePluginSetupActions(raw)[0]).toMatchObject({
      kind: "secret",
      action,
      secret: secretPresentation,
    });
    expect(JSON.stringify(mobilePluginSetupActions(raw))).not.toContain(
      "must never project",
    );
    expect(mobilePluginSetupActions({ ...raw, remoteSecret: false })).toEqual(
      [],
    );
    expect(mobilePluginSetupActions({ ...raw, terminal: true })).toEqual([]);
    expect(
      mobilePluginSetupActions({
        ...raw,
        steps: [{ ...raw.steps[0], phase: "satisfied" }],
      }),
    ).toEqual([]);
  });
});

describe("代输入 screenshot step on the phone", () => {
  // Distinctive base64 so a plaintext leak in the tunnel would be visible.
  const picture = { mime: "image/jpeg" as const, width: 800, height: 600, data: "c3ludGhldGljLXBpY3R1cmUtYnl0ZXM=" };
  const presentation = {
    requestId: "card",
    revision: 0,
    purpose: "Sign in",
    source: { app: "Game" },
    command: null,
    controls: [],
    picture: true,
    qr: false,
  };
  const inputAction = { requestId: "card", actionId: "step", expectedRevision: 0 };
  function pictureHost() {
    const answered = vi.fn(),
      requests: unknown[] = [];
    const host = new OauthTransactions({
      owner: () => "account",
      available: () => true,
      bind: async () => ({ ghostId: "cindy-input-handoff", current: () => true }),
      run: () => {
        const remote = getRemoteOauthContext()!;
        void (async () => {
          try {
            const state = randomBytes(32).toString("base64url");
            answered(await remote.submitInput!({ kind: "input-entry", state, presentation, picture }));
            remote.finish(true);
          } catch {
            remote.finish(false);
          }
        })();
        return true;
      },
    });
    return {
      answered,
      requests,
      invoke: async (request: Parameters<OauthTransactions["request"]>[1]) => {
        requests.push(request);
        return host.request("phone", request);
      },
    };
  }

  it("shows the sealed picture and returns the owner's tap on the same exchange", async () => {
    const h = pictureHost();
    const shown = vi.fn();
    const tap = { expectedRevision: 0, values: {}, action: { kind: "tap" as const, x: 0.5, y: 0.5 } };
    await runMobilePluginAuthorization({
      crypto,
      action: inputAction,
      kind: "input",
      invoke: h.invoke,
      assertCurrent: () => {},
      pause: async () => {},
      clearInput: () => {},
      inputPresentation: presentation,
      inputPicture: async (received) => {
        shown(received);
        return tap;
      },
      showAuthorization: async () => {
        throw Error("No browser expected");
      },
    });
    expect(shown).toHaveBeenCalledWith(picture);
    expect(h.answered).toHaveBeenCalledWith(tap);
    expect(JSON.stringify(h.requests)).not.toContain(picture.data);
  });

  it("never hands a picture to a prepared form answer", async () => {
    const h = pictureHost();
    await expect(
      runMobilePluginAuthorization({
        crypto,
        action: inputAction,
        kind: "input",
        invoke: h.invoke,
        assertCurrent: () => {},
        pause: async () => {},
        clearInput: () => {},
        inputPresentation: presentation,
        inputSubmission: { expectedRevision: 0, values: {}, action: { kind: "submit" } },
        showAuthorization: async () => {},
      }),
    ).rejects.toThrow("OAUTH_BRIDGE_UNAVAILABLE");
    expect(h.answered).not.toHaveBeenCalled();
    expect(h.requests.at(-1)).toMatchObject({ op: "cancel" });
  });
});
