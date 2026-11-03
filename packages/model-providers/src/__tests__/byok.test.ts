import { describe, expect, it } from "vitest";
import {
  parseByokCredentialsResponse,
  parseByokProvidersResponse,
} from "../byok.js";

const directory = {
  schemaVersion: 1,
  organizationId: "org-a",
  revision: "1",
  providers: [
    {
      id: "byok-provider-a",
      name: "企业模型",
      connectionRevision: 1,
      models: [
        {
          nativeApi: "openai-completions",
          id: "byok/a/chat",
          name: "Chat",
          currency: "CNY",
          mode: "chat",
          agents: ["pi"],
          perAgent: { pi: { wireProtocol: "openai-completions" } },
          contextWindow: 128000,
          inputCostPerToken: 0,
          outputCostPerToken: 0.000002,
        },
      ],
    },
  ],
};
const ready = {
  providerId: "byok-provider-a",
  connectionRevision: 1,
  status: "ready",
  endpoint: "https://gateway.example.invalid/v1",
  apiKey: "invalid-test-key",
};
const credentials = {
  schemaVersion: 1,
  organizationId: "org-a",
  credentials: [ready],
};

describe("BYOK wire contract", () => {
  it("preserves a full Provider-prefixed model ID and rejects oversized IDs", () => {
    const providerId = "byok-" + "p".repeat(186);
    const id = providerId + "/" + "m".repeat(256);
    const response = (modelId: string) => ({
      ...directory,
      providers: [
        {
          ...directory.providers[0],
          id: providerId,
          models: [{ ...directory.providers[0].models[0], id: modelId }],
        },
      ],
    });
    const parsed = parseByokProvidersResponse(response(id));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.providers[0].models[0].id).toBe(id);
    expect(parseByokProvidersResponse(response(id + "m")).ok).toBe(false);
    expect(parseByokProvidersResponse(response("m".repeat(257))).ok).toBe(
      false,
    );
  });

  it("reuses model metadata and preserves an explicit zero price", () => {
    const result = parseByokProvidersResponse(directory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providers[0].models[0].nativeApi).toBe(
        "openai-completions",
      );
      expect(result.value.providers[0].models[0].inputCostPerToken).toBe(0);
      expect(
        result.value.providers[0].models[0].perAgent.pi?.wireProtocol,
      ).toBe("openai-completions");
    }
  });
  it("accepts only the strict image binding contract", () => {
    const imageBinding = {
      enabled: true,
      modelId: "gpt-image-2",
      name: "Enterprise Images",
      supportsEdit: true,
      wireModel: "gpt-image-2",
      litellmModel: "byok-provider-a/gpt-image-2",
    };
    const response = {
      ...directory,
      providers: [{ ...directory.providers[0], imageBinding }],
    };
    const parsed = parseByokProvidersResponse(response);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value.providers[0].imageBinding).toEqual(imageBinding);

    for (const malformed of [
      { ...imageBinding, enabled: false },
      { ...imageBinding, supportsEdit: "yes" },
      { ...imageBinding, extra: true },
    ]) {
      expect(
        parseByokProvidersResponse({
          ...directory,
          providers: [{ ...directory.providers[0], imageBinding: malformed }],
        }).ok,
      ).toBe(false);
    }
  });
  it("accepts an authoritative empty directory", () => {
    expect(parseByokProvidersResponse({ ...directory, providers: [] }).ok).toBe(
      true,
    );
  });
  it("rejects duplicate providers, reserved identities and secrets in the directory", () => {
    expect(
      parseByokProvidersResponse({
        ...directory,
        providers: [...directory.providers, ...directory.providers],
      }).ok,
    ).toBe(false);
    for (const extra of [
      { id: "xd" },
      { apiKey: "invalid-test-key" },
      { connectionRevision: 0 },
      { models: [] },
    ]) {
      expect(
        parseByokProvidersResponse({
          ...directory,
          providers: [{ ...directory.providers[0], ...extra }],
        }).ok,
      ).toBe(false);
    }
  });
  it("rejects malformed model metadata instead of accepting a partial snapshot", () => {
    expect(
      parseByokProvidersResponse({
        ...directory,
        providers: [
          {
            ...directory.providers[0],
            models: [
              { ...directory.providers[0].models[0], currency: "UNKNOWN" },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });
  it("requires an explicit Pi protocol and rejects duplicate model IDs", () => {
    const model = directory.providers[0].models[0];
    for (const models of [
      [{ ...model, perAgent: { pi: {} } }],
      [model, model],
    ]) {
      expect(
        parseByokProvidersResponse({
          ...directory,
          providers: [{ ...directory.providers[0], models }],
        }).ok,
      ).toBe(false);
    }
  });
  it("accepts standalone image-generation models without chat engines", () => {
    const result = parseByokProvidersResponse({
      ...directory,
      providers: [
        {
          ...directory.providers[0],
          models: [
            directory.providers[0].models[0],
            {
              nativeApi: "openai-images",
              id: "byok/a/gpt-image-2",
              name: "Draw",
              currency: "CNY",
              mode: "image_generation",
              agents: [],
              perAgent: {},
              modalities: { input: ["text", "image"], output: ["image"] },
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.value.providers[0].models.map((model) => model.mode),
      ).toEqual(["chat", "image_generation"]);
      expect(result.value.providers[0].models[1]?.agents).toEqual([]);
      expect(result.value.providers[0].models[1]?.nativeApi).toBe(
        "openai-images",
      );
    }
  });
  it("rejects image-generation models that still declare chat engines", () => {
    expect(
      parseByokProvidersResponse({
        ...directory,
        providers: [
          {
            ...directory.providers[0],
            models: [
              { ...directory.providers[0].models[0], mode: "image_generation" },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });
  it("rejects video and other gateway-unready standalone modes", () => {
    const model = directory.providers[0].models[0];
    for (const mode of [
      "video_generation",
      "audio_speech",
      "embedding",
      "realtime",
    ]) {
      expect(
        parseByokProvidersResponse({
          ...directory,
          providers: [
            {
              ...directory.providers[0],
              models: [{ ...model, mode, agents: [], perAgent: {} }],
            },
          ],
        }).ok,
      ).toBe(false);
    }
  });
  it("accepts independently ready, pending and failed credential items", () => {
    expect(
      parseByokCredentialsResponse({
        ...credentials,
        credentials: [
          ready,
          {
            providerId: "byok-provider-b",
            connectionRevision: 2,
            status: "pending",
          },
          {
            providerId: "byok-provider-c",
            connectionRevision: 3,
            status: "error",
            code: "REVOKED",
          },
        ],
      }).ok,
    ).toBe(true);
  });
  it("allows HTTP only for loopback inference endpoints", () => {
    for (const endpoint of [
      "http://127.0.0.1:32769",
      "http://localhost:32769",
      "http://[::1]:32769",
    ]) {
      expect(
        parseByokCredentialsResponse({
          ...credentials,
          credentials: [{ ...ready, endpoint }],
        }).ok,
      ).toBe(true);
    }
    expect(
      parseByokCredentialsResponse({
        ...credentials,
        credentials: [
          { ...ready, endpoint: "http://gateway.example.invalid/v1" },
        ],
      }).ok,
    ).toBe(false);
  });
  it("rejects duplicate, incomplete, ambiguous and unsafe credentials without echoing secrets", () => {
    expect(
      parseByokCredentialsResponse({
        ...credentials,
        credentials: [ready, ready],
      }).ok,
    ).toBe(false);
    for (const patch of [
      { apiKey: "" },
      { connectionRevision: 1.5 },
      { status: "pending" },
      { endpoint: "http://gateway.example.invalid" },
      { endpoint: "https://user:secret@example.invalid/v1" },
      { endpoint: "https://example.invalid/v1?key=secret" },
    ]) {
      const result = parseByokCredentialsResponse({
        ...credentials,
        credentials: [{ ...ready, ...patch }],
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("invalid-test-key");
    }
  });
});
