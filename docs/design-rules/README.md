# 设计规则

这里存放 Cindy 客户端必须遵守的视觉、交互、内容和跨端设计规范。

## 使用规则

- 新增或修改界面、组件、布局、样式、动效或 UI 文案前，必须先读取相关设计规范。
- 产品目标和能力边界放在 `docs/product-rules/`，代码架构与工程实现约束放在
  `docs/dev-rules/`，不要混入本目录。
- 能由设计 Token、组件原语、lint 或测试保证的规则，应同步落实到代码和自动检查，
  不能只依赖 Agent 阅读文档。

## 当前规范

- 设计文档一律放本目录，索引与版本台账见
  [`cindy-design-system.md`](./cindy-design-system.md)。
- 权威视觉规范正本为 [`DESIGN.md`](./DESIGN.md)（视觉语言、颜色与主题 Token、排版、
  组件、布局、动效、交互、内容规范、登录链路）；仓库根 `DESIGN.md` 仅为跳转入口。
- 登录域逐参数与 token 决策见 [`figma-component-spec.md`](./figma-component-spec.md)
  与 [`token-decision-table.md`](./token-decision-table.md)。
