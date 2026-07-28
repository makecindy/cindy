# Cindy 设计系统索引

> 本文件是 `docs/design-rules/` 全部设计文档的索引与版本台账（2026-07-24 起启用，此前为跳转 stub）。
> 设计类 `.md` 一律放本目录，并在下表登记；规范正文不要写进本文件。

## 文档索引

| 文档 | 内容 | 角色 |
|---|---|---|
| [`DESIGN.md`](./DESIGN.md) | 权威视觉规范全文：视觉语言（§1）、颜色（§2）、排版（§3）、组件（§4）、布局（§5）、交互约定与 Motion token（§14）、主题系统与 Token 参考（§10）、CINDY 皮肤族（§15）、登录链路（§16） | **权威正本**（原仓库根文件，根目录 `DESIGN.md` 保留为跳转入口） |
| [`figma-component-spec.md`](./figma-component-spec.md) | 登录链路 Figma 组件与色彩速查手册：全组件逐态参数、nodeId 溯源、wave1–wave5 读取记录 | 权威（登录域逐参数） |
| [`token-decision-table.md`](./token-decision-table.md) | 登录链路色值 / 尺寸 → token 决策记录（新增 / 复用 / 豁免的判定理由 + 各 wave 增补台账） | 决策记录（现行 token 清单与值以 `DESIGN.md §16.1` + `colors.ts` 为准） |
| [`design-decision-log.md`](./design-decision-log.md) | 全局设计决策史台账：被推翻的方案、勘误过程、backlog（已收录原 `DESIGN.md §13` G1–G4 归档与 §15 决策史全量） | 决策台账（只增不改；与 `DESIGN.md` 冲突时以 `DESIGN.md` 为准） |
| [`README.md`](./README.md) | 本目录使用规则 | 说明 |

## 版本记录

- **2026-07-26**：`DESIGN.md §10` 新增「External Theme Import (VSCode / Obsidian)」小节——外部主题导入只映射从 7 个人工移植社区主题抽出的 91-token 模板、语义豁免族（`--login-*` / 危险红 / 警告橙 / 焦点蓝 / `--diff-*`）不参与导入、`-hsl` token 精确换算、新增 `--md-h1-fg`…`--md-h6-fg` / `--md-strong-fg`（默认 `inherit`，内置主题观感不变）、本地主题可选 `family` 字段。决策理由与取舍见 [`design-decision-log.md`](./design-decision-log.md) 2026-07-26 条。
- **2026-07-24（梳理批次 1）**：`DESIGN.md` 整体梳理第一批落地——去除 Ollama 官网叙事（标题改 `Cindy Design System`，§1/§4/§5/§8/§9 重写或删除官网内容）；focus ring 文档追平代码（`#3b82f6` → `#417CDD`）；§2/§9 二级三级文字与 chip 双 slot 表述按 `colors.ts` 修正；§10 移除写死 token 计数与过时豁免行；§12 结构化规格并入 §4（§12 编号留占位）；§13 G1–G4 归档至新建 [`design-decision-log.md`](./design-decision-log.md)；§14/§15/§16 若干失效指向修正。
- **2026-07-24**：目录整编（设计 md 统一归位 `docs/design-rules/`，本文件升级为索引）。同步 Figma 组件库更新：hover 统一「叠白变亮」口径（旧「白底钮 hover 叠黑」作废）、新增协议勾选 `radiobutton` 四态与双色模式小按钮四母版、`SSO 登录_企业` / `back` 扩 Dark 三态、`white_button` 增 loading 五态（`figma-component-spec §11`、`DESIGN.md §16.5`）。`figma-component-spec.md` / `token-decision-table.md` 自迁移前仓库最后版本恢复并更新至 wave5。
- **2026-07-23**：`DESIGN.md` 新增 §16 登录链路（登录全链路设计规范、`--login-*` 双态 token 表、深色模式落地机制）。
