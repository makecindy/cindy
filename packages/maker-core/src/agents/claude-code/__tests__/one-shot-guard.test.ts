import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: h.create };
  },
  APIError: class APIErrorMock extends Error {},
}));

import { ClaudeCodeAgent } from "../index.js";
import type { AgentDeps } from "../../base-agent.js";
import type { AuthAdapter } from "../../../interfaces/auth-adapter.js";
import type { Logger } from "../../../interfaces/logger.js";

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return { ANTHROPIC_API_KEY: "test-key" };
    },
  };

  return {
    auth,
    runtimeConfig: { endpoint: "https://example.test" },
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
}

describe("ClaudeCodeAgent oneShot dispatch guard", () => {
  beforeEach(() => {
    h.create.mockReset();
    h.create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it("fails closed before the Anthropic request when the guard rejects", async () => {
    const beforeDispatch = vi.fn(async () => false);
    const agent = new ClaudeCodeAgent(createDeps());

    await expect(
      agent.oneShot("hello", { beforeDispatch }),
    ).rejects.toMatchObject({
      reason: "network",
    });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("dispatches when the guard accepts", async () => {
    const beforeDispatch = vi.fn(async () => true);
    const agent = new ClaudeCodeAgent(createDeps());

    await expect(agent.oneShot("hello", { beforeDispatch })).resolves.toBe(
      "ok",
    );
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
  });
});
