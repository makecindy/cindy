# 插件工具生命周期协议

`subscribe.hooks` 增量识别 `will-tool-call` / `did-tool-result`；后者仍是同步控制节点，
不扩展 topic。裁决新增 `action:'tool'` 和 `tool` 原生效果字段，不能替主人批准；旧声明、
receipt 与节点批准不重写。旧宿主保留未知声明并报告不支持，作者按随包支持表降级。
仅本机引擎接线，不新增 device-link channel 或 relay payload；自建中转无需变更。

作者字段与引擎支持差异见[原生工具生命周期](../../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-control-points.md#原生工具生命周期)。
运行期主入口为 `toolLifecycleControl.ts`，Pi 复用 cindy-bridge，Claude 复用 SDK callbacks。
Codex 不自动接入，不复制内部信任格式；协议保留其引擎枚举，不据此宣称已接线。
验证见 Claude 钩子测试、Pi 原生集成用例与 `ghostInstallReceipt.test.ts` 的旧 receipt 读回用例。
仅 Pi 支持 `tool.input`；Claude 沿用 SDK 钩子执行，不重排宿主 callbacks。节点按原生实例启动时的
订阅分别安装；调用时实时读取选择，在途选择／owner 变更 no-op，不引入实例级选择快照或热更新。
