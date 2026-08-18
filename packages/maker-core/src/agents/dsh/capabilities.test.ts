import { describe, expect, it } from "vitest";

import type { AgentDeps } from "../base-agent.js";
import { DshAgent } from "./index.js";

function createAgent(): DshAgent {
  return new DshAgent({
    binaryPath: "dsh-test",
    auth: {} as AgentDeps["auth"],
    runtimeConfig: {} as AgentDeps["runtimeConfig"],
    logger: {} as AgentDeps["logger"],
  });
}

describe("DshAgent capabilities", () => {
  it("starts with an empty model list until the host injects catalog-derived models", () => {
    expect(createAgent().capabilities.availableModels).toEqual([]);
  });
});
