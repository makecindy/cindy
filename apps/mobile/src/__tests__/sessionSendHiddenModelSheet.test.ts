import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// #5580：已有任务当前模型被电脑端关闭后，直接点发送会被拦截并自动打开模型面板。
// 面板只在「浏览引擎 = 当前选择所在引擎」时把原选模型认作当前选择并显示重选提示；
// 发送入口必须像手动打开入口一样先初始化浏览引擎，否则首次直接发送看不到提示。
const readTextLf = (path: string): string =>
  String(readFileSync(resolve(process.cwd(), path), "utf8")).replace(/\r\n/g, "\n");

const screen = readTextLf("app/sessions/[sessionId].tsx");

function hiddenModelSendBlock(): string {
  const start = screen.indexOf("modelNeedsReselection(\n      getCachedDeviceProviders(deviceId)?.modelVisibilityOverrides,");
  expect(start).toBeGreaterThan(0);
  const end = screen.indexOf("return;\n    }", start);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe("session send blocked by a hidden model", () => {
  it("points the model sheet at the selection being validated before opening it", () => {
    const block = hiddenModelSendBlock();
    const init = block.indexOf("setModelSheetAgentKind(selectionAtSend.agentKind);");
    const open = block.indexOf("setModelSheetOpen(true);");
    expect(init).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(init);
  });

  it("validates the pending cross-agent target, matching the manual picker entry", () => {
    expect(screen).toContain(
      "? { agentKind: intentAtSend.targetAgentKind, model: intentAtSend.model, providerId: intentAtSend.providerId }",
    );
    expect(screen).toContain("setModelSheetAgentKind(agentSwitchIntent?.targetAgentKind ?? sessionAgentKind);");
  });
});
