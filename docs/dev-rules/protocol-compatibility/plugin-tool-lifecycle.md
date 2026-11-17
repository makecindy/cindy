# 插件工具生命周期协议

`subscribe.hooks` 增量识别 `will-tool-call` / `did-tool-result`；后者仍是同步控制节点，
不扩展 topic。裁决新增 `action:'tool'` 和 `tool` 原生效果字段，不能替主人批准；旧声明、
receipt 与节点批准不重写。旧宿主保留未知声明并报告不支持，作者按随包支持表降级。
仅本机引擎接线，不新增 device-link channel 或 relay payload；自建中转无需变更。

作者字段与引擎支持差异见[原生工具生命周期](../../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-control-points.md#原生工具生命周期)。
运行期主入口为 `toolLifecycleControl.ts`，Codex 复用原生 MCP hook 模板和同一 Agent MCP 通道，
Pi 复用 cindy-bridge，Claude 复用 SDK callbacks。验证见 `native-tool-hooks.integration.test.ts`、
Pi 原生集成用例与 `ghostInstallReceipt.test.ts` 的旧 receipt 读回用例。
