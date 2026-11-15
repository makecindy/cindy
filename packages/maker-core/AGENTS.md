# maker-core：Agent 工作入口

本文件适用于 `packages/maker-core/`；[根 AGENTS](../../AGENTS.md) 的授权、system prompt、
Pi 原生能力、协议兼容与交付规则仍然适用。

- 修改 Agent 编排、prompt 组装、tool／MCP 暴露、translator、model 映射、usage 计量，
  或任何进入模型 system 段的提示词前，必须先读
  [maker-core 与 Agent 行为](../../docs/dev-rules/maker-core-and-agent-behavior.md)。
- Pi harness 的专用规则见[Pi harness](../../docs/dev-rules/pi-harness.md)；
  跨 package 依赖与宿主注入边界见[架构不变量](../../docs/dev-rules/architecture-invariants.md)。
  这些专题的触发条件和红线保留在根入口，不因调用方位于其他模块而失效。
- 宿主发送、权限切换与恢复入口，以及相应测试见
  [仓库地图的行为导航](../../docs/dev-rules/repo-map.md#按用户行为定位)；修改核心行为时一并定位调用方。
