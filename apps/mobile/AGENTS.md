# Mobile：Agent 工作入口

本文件适用于 `apps/mobile/`；[根 AGENTS](../../AGENTS.md) 的数据、授权、跨端协议、
产品、设计与交付规则仍然适用。代码、共享判据与测试入口见
[仓库地图](../../docs/dev-rules/repo-map.md#按用户行为定位)。

- 开发、调试或验证 Mobile 时，必须先读[Mobile 开发](../../docs/dev-rules/mobile-development.md)。
- 修改本模块的原生配置、原生依赖、config plugin 或原生模块（`app.json`、
  `app.config.js`、`eas.json`、`package.json`、`plugins/`、`modules/` 等会
  进入 runtime fingerprint 的输入）前，必须先读[Mobile 开发](../../docs/dev-rules/mobile-development.md)
  的「冷更边界」：**除非必要，不得提交会改变指纹的改动**；会触发冷更的 PR 与技术框架
  变动同级，必须由仓库指定的把关人针对冷更明确确认后才能合并——不看改动大小，也不看谁
  提的，提交者身份不构成例外。
- 新增或修改 Mobile 界面上的文字前，必须先查
  [Mobile 设计指南](docs/mobile-design-guide.md) §3「文字规范速查」：先定角色，再整行照抄字号、
  行高、字重、字色；五档中性字色、浅色字不配粗字重、11 档字号、必须配行高四条由
  `typographyTokenDiscipline.test.ts` 守护，角色是否选对靠 review。
