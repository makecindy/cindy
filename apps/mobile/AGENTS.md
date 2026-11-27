# Mobile：Agent 工作入口

本文件适用于 `apps/mobile/`；[根 AGENTS](../../AGENTS.md) 的数据、授权、跨端协议、
产品、设计与交付规则仍然适用。代码、共享判据与测试入口见
[仓库地图](../../docs/dev-rules/repo-map.md#按用户行为定位)。

- 开发、调试或验证 Mobile 时，必须先读[Mobile 开发](../../docs/dev-rules/mobile-development.md)。
- 修改本模块的原生配置、原生依赖、config plugin 或原生模块（`app.json`、
  `app.config.js`、`eas.json`、`package.json`、`plugins/`、`modules/` 等会
  进入 runtime fingerprint 的输入）前，先读[Mobile 开发](../../docs/dev-rules/mobile-development.md)
  的「冷更边界」：**鼓励为了更好的用户体验积极采用原生方案并正常触发冷更**，不要为回避冷更
  而用体验更差的 JS 模仿凑合；纯 JS / UI 改动避免无意误碰指纹输入；有原生改动时必须做好
  旧原生包的能力探测与平滑降级，并在 PR Description 简明写清影响平台、体验／能力变化与旧包表现。
- 新增或修改 Mobile 界面上的文字前，必须先查
  [Mobile 设计指南](docs/mobile-design-guide.md) §3「文字规范速查」：先定角色，再整行照抄字号、
  行高、字重、字色；五档中性字色（含占位字只用 `textPlaceholder`）、浅色字不配粗字重、
  必须配行高由 `typographyTokenDiscipline.test.ts` / `textColorDiscipline.test.ts` 守护，11 档字号由 `themeTokens.test.ts`
  守护，角色是否选对靠 review。
