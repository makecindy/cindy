import { describe, expect, it } from "vitest";

import { resolveSystemLocale } from "../locale";

describe("mobile locale resolution", () => {
  it("prioritizes explicit Chinese scripts over conflicting regions", () => {
    expect(resolveSystemLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-Hant-CN")).toBe("zh-TW");
  });

  it("routes Chinese regions and scripts to the matching UI catalog", () => {
    expect(resolveSystemLocale("zh-CN")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-SG")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-TW")).toBe("zh-TW");
    expect(resolveSystemLocale("zh-HK")).toBe("zh-TW");
    expect(resolveSystemLocale("zh-Hant")).toBe("zh-TW");
  });
});
