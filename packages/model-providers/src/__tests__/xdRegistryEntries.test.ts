import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseModelRegistry } from "../modelAccessValidator.js";

const registry = JSON.parse(
  readFileSync(new URL("../../catalog/model-registry.json", import.meta.url), "utf8"),
) as { models: { id: string; routes: { providerId: string }[] }[] };

describe("XD 路由独立条目", () => {
  it("XD 路由不与其他供应商共用条目，XD 的显示与排序可单独维护", () => {
    // 服务端生成 Gateway /models 时读取 XD 路由所在条目的 defaultEnabled / sortOrder;
    // 与订阅共用条目会让订阅侧的显示调整连带改动 XD。
    const mixed = registry.models
      .filter((entry) => {
        const providers = new Set(entry.routes.map((route) => route.providerId));
        return providers.has("xd") && providers.size > 1;
      })
      .map((entry) => entry.id);
    expect(mixed).toEqual([]);
  });

  it("拆分后的离线 Registry 仍通过协议校验", () => {
    expect(parseModelRegistry(registry).ok).toBe(true);
  });
});
