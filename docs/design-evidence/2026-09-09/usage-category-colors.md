# 用量历史分类配色

## 当前：pi 青绿

所有者认为蓝色与紫色不易区分，指定 pi 改为青绿。三处 pi 标记统一消费 `--usage-model-1`，Light 实测 `rgb(20, 184, 166)`，Dark 实测 `rgb(45, 212, 191)`；Claude 陶土橙与 Codex 蓝色保持。沿用下述真实 Electron 沙箱与模拟数据重新检查，35 个模型、三处 harness 颜色对应与单日筛选检查通过。当前文件为同一忽略目录下 `pi-light.png`、`pi-dark.png`、`pi-light.json`、`pi-dark.json` 和 `pi-manifest.json`；之前的 brand 文件保留作历史对照。

## 上一版：harness 身份色调整

同日按所有者反馈，harness 的三处标记改为已有引擎身份色；下文初版青绿 / 靛蓝 / 琥珀记录仅保留作历史对照。真实 Electron 再次检查 Default Light 与 Default Dark：三种颜色分别为 `rgb(217, 119, 87)`（Claude 陶土橙）、`rgb(122, 157, 255)`（Codex 蓝）、`rgb(167, 139, 250)`（pi 紫）。两种模式同值符合这些身份 Token 的既有合同，模型颜色与日期筛选检查继续通过。

同一忽略目录中 `brand-light.png`、`brand-dark.png`、`brand-light.json`、`brand-dark.json` 与 `brand-manifest.json` 对应该版（harness 身份色版）实现；数据与平台条件同下。静态单测与 Desktop typecheck 重新执行。新增 Token 消费后先重新生成 design inventory，再通过相关测试门禁。未新增 Token 或修改种子值；视觉批准仍待设计师完成。

## 初版证据

- 日期：2026-09-09；平台：macOS Desktop / Electron；主题：Default Light、Default Dark。
- 分支：`fix/usage-category-colors`；基于 `ebcb181a5b61f8c27984190f76de687e576b1686`，证据对应本次未提交源码，相关生产文件的 Git blob 记录在本地 manifest。提交后以文件 blob 核对，不把启动脚本打印的基线 SHA 当作改后源码 SHA。
- 实例：独立 `usage-colors-20260909` 沙箱，CDP 9246；1280×800 CSS px，DPR 2。启动结果 `DESKTOP_DEV_VERDICT=ready`。
- 数据：35 个明确标为 `preview-model-*` 的模拟模型、三个 harness、40 天用量，通过 CDP 注入真实页面的内存数据状态；实际 `UsageHistorySection` 与其子组件正常渲染，无替代 HTML 样张。未写入真实账号的数据库，也未验证生产用量采集链路。

## 验证结果

- 35 个模型均得到非透明分类色；模型表色块、占比短条与每日柱图对应片段的 computed 颜色一致，柱体保留 35 个片段。
- Agent 顶部占比条、行前色块与占比短条一致（按 Claude / Codex / pi 顺序）。Light：`rgb(217, 119, 87)` / `rgb(122, 157, 255)` / `rgb(20, 184, 166)`；Dark：`rgb(217, 119, 87)` / `rgb(122, 157, 255)` / `rgb(45, 212, 191)`。初版青绿 / 靛蓝 / 琥珀方案的实测值（Light `rgb(20, 184, 166)` / `rgb(99, 102, 241)` / `rgb(245, 158, 11)`，Dark `rgb(45, 212, 191)` / `rgb(129, 140, 248)` / `rgb(251, 191, 36)`）已随方案废弃，仅保留作历史对照。
- Electron 支持从主题变量派生 OKLCH；两种主题的所有模型 computed 值见 JSON。
- 单日点击保持筛选，柱高不变，柱体四角仍为 2px。现有命中尺寸欠账不由本次颜色测试解决。
- `pnpm test:unit:related`、`pnpm --filter desktop run --if-present typecheck` 通过。测试覆盖 1000 个颜色分配、35 个模型的分段/表格对应、Agent 排名反转、早于 30 天的历史模型与单日筛选。
- 仅修改 Desktop；未测试 Mobile、其他操作系统和自定义主题组合。AI 采集和检查不构成设计师视觉批准。

## 截图与记录

当前版本的栅格证据保存在工作区忽略目录 `.cindy/usage-category-evidence-2026-09-09/`：

- `pi-light.png`、`pi-dark.png`：当前实现（pi 青绿版）的 Agent 表与模型表，Default Light / Default Dark。
- `pi-light.json`、`pi-dark.json`：逐项 computed 颜色与几何记录；三种 harness 色、35 个模型色、35 个柱体分段与 2px 圆角均已核对。
- `pi-manifest.json`：证据采集时来源 commit `3a8f6cce2`、源文件 git blob 与各证据文件校验值。修复轮（2026-09-09）复核这四个源文件 blob 与 PR head `377baf24de` 仍逐项一致；本轮修复仅改本文档，不改运行时代码，证据继续对应最终提交版本。
- 初版的 `light-tables.png`、`dark-tables.png`、`dark-models-tail.png`、`light.json`、`dark.json`、`manifest.json` 与 harness 身份色版的 `brand-*` 文件保留作历史对照。

尚未上传 PR 附件：按治理合同 §6，栅格证据须由人经 PR 评论附件上传（`gh` CLI 与 API 不能传图），上传后把该评论链接回写本索引作为稳定入口。设计师视觉验收待完成，AI 采集与核对不构成批准；截图中的模型名与数值均为测试数据。
