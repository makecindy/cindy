import { shouldShowSourceDevice } from "@cindy/maker-shared/message-source";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import {
  automationOriginLabel,
  isSourceDeviceRemoved,
  orcaMessageTitle,
  shortDeviceId,
  sourceDeviceDisplayName,
  sourceDeviceLabel,
  sourcePluginLabel,
} from "@/session/messageSourceLabels";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const phone = {
  deviceId: "3f2a91c0-aaaa-bbbb",
  name: "快照名",
  platform: "mobile" as const,
};

describe("device source label", () => {
  it("is hidden when the viewer is the sending device and shown otherwise", () => {
    expect(shouldShowSourceDevice(phone, phone.deviceId)).toBe(false);
    expect(shouldShowSourceDevice(phone, "another-phone")).toBe(true);
    expect(shouldShowSourceDevice(undefined, "another-phone")).toBe(false);
  });

  it("prefers the live name by device id and falls back to the snapshot", () => {
    expect(
      sourceDeviceDisplayName(phone, [
        { deviceId: phone.deviceId, name: "改名后" },
      ]),
    ).toBe("改名后");
    expect(sourceDeviceDisplayName(phone, [])).toBe("快照名");
    expect(
      sourceDeviceDisplayName({ deviceId: "x", platform: "desktop" }, []),
    ).toBeUndefined();
  });

  it("appends a short id when another device has the same name", () => {
    const directory = [
      { deviceId: phone.deviceId, name: "iPhone" },
      { deviceId: "ffff-0000", name: "iPhone" },
    ];
    expect(shortDeviceId(phone.deviceId)).toBe("3f2a91");
    expect(sourceDeviceLabel(phone, directory)).toBe(
      "从手机「iPhone (3f2a91)」发送",
    );
    // 已删除设备用快照名,与仍在清单里的同名设备同样要消歧。
    expect(
      sourceDeviceLabel({ ...phone, name: "iPhone" }, [
        { deviceId: "ffff-0000", name: "iPhone" },
      ]),
    ).toBe("从手机「iPhone (3f2a91)」发送");
  });

  it("uses phone / computer wording with and without a name", () => {
    expect(sourceDeviceLabel(phone, [])).toBe("从手机「快照名」发送");
    expect(sourceDeviceLabel({ deviceId: "p", platform: "mobile" }, [])).toBe(
      "从手机发送",
    );
    expect(
      sourceDeviceLabel(
        { deviceId: "m", name: "MacBook", platform: "desktop" },
        [],
      ),
    ).toBe("从电脑「MacBook」发送");
    expect(sourceDeviceLabel({ deviceId: "m", platform: "desktop" }, [])).toBe(
      "从电脑发送",
    );
  });

  it("treats a device as removed only when the loaded directory lacks it", () => {
    expect(isSourceDeviceRemoved(phone.deviceId, [])).toBe(false);
    expect(
      isSourceDeviceRemoved(phone.deviceId, [
        { deviceId: "other", name: "Mac" },
      ]),
    ).toBe(true);
    expect(
      isSourceDeviceRemoved(phone.deviceId, [
        { deviceId: phone.deviceId, name: "iPhone" },
      ]),
    ).toBe(false);
  });
});

describe("sender labels", () => {
  it("formats plugin, automation (incl. redacted) and Orca titles with the shared wording", () => {
    expect(sourcePluginLabel({ pluginId: "p", name: "日报" })).toBe(
      "由插件「日报」发送",
    );
    expect(sourcePluginLabel({ pluginId: "p" })).toBe("由插件发送");
    expect(automationOriginLabel({ scheduleName: "PR 心跳" })).toBe(
      "由自动化「PR 心跳」发送",
    );
    expect(automationOriginLabel({})).toBe("由自动化发送");
    expect(orcaMessageTitle("lead", "Lead")).toBe("来自 Lead 的消息");
    expect(orcaMessageTitle("worker", "frontend")).toBe(
      "来自 Worker「frontend」的消息",
    );
    expect(orcaMessageTitle("worker", "Worker")).toBe("来自 Worker 的消息");
    expect(orcaMessageTitle("worker")).toBe("来自 Worker 的消息");
  });
});
