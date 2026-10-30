# 用量图表形状、配色与日期选择：视觉证据索引

## 当前同步版本（2026-09-08）

本节记录本次同步的实际结果；后续旧章节为历史采样，不代表当前日期入口、描边、透明度或字号。

- 基于远端 `779f9f47bc57005b9cdda8f46f88390cab435793` 保留颜色分类修复，再同步本文件所在提交的本地 UI 优化。生产文件 blob 与附件 SHA-256 绑定在本地 `sync-manifest.json`，推送后该清单补记最终提交 SHA。
- 实际运行中的 macOS arm64 / Electron 41.10.3 / Global 隔离开发版，六组模型、150 天合成用量。模型名 `fixture-model-*` 为测试名称，不是真实用量。未修改正式数据库。
- Light/Dark 均已检查默认无单日选中、七个日历日范围强调、单日联动、超出柱图窗口的日期无柱选中；非强调柱 opacity=0.6，柱高不随选择变化。热力格选中 14×14px，独立描边 1px、间隙 1px；键盘焦点仍为 2px。新增日期表单已移除。
- Light/Dark 均实测概览字号 16px、字重 500；正文表格 13px、表头 12px、图表月份 11px。临时把本页字体 Token 按 UI 字号 14→18 放大，概览 computed 21px，无水平溢出；测试后恢复，未修改用户字体偏好。任务表无测试数据，未作实机验收。
- 最新真实截图：`sync-light-default.png` / `sync-dark-default.png`，以及两种主题各自的 `sync-*-week.png` / `sync-*-selected.png` / `sync-*-outside.png`；实测数据为 `sync-light.json` / `sync-dark.json` 与 `sync-typography-*.json`。均在忽略目录 `.cindy/usage-chart-evidence-2026-09-08/`，尚未上传公开附件。PR 评论中早先的近似 HTML 预览不代表本次最终 UI。
- `pnpm test:unit:related`（runner、Desktop、design-tokens）、两包 typecheck、DCO、Prettier、`git diff --check`、i18n 与术语检查通过；i18n 保留已有警告。源代码契约按所有者删除新增日期入口的要求更新，保留两图筛选与固定数据窗口验证，不将其称为目标尺寸合规测试。
- **仅按所有者要求同步供评审，暂不合并。** 移除等价日期入口后的点击尺寸方案仍未解决，不批准 Essential 豁免；依赖 #4072 的登记规范与最终证据收口仍保留。公开实机附件、最终视觉验收记录、Windows/Linux 实机和屏幕阅读器验证未完成。

## 历史证据记录

日期：2026-09-08。平台：Desktop / macOS arm64，Global 隔离开发版，Electron 41.10.3。PR：[#4076](https://github.com/makecindy/cindy/pull/4076)，类别：有意可见变化。图表形状修复前基线：`760005b411406daca9016b2c33a6876c5d3de4f9`；首轮灰阶几何修复：`723fad34eb7cc12fbba43533a7dacf8a5340c793`。

- 实际场景：运行中的 Cindy → 设置 → 用量历史；独立临时 userData。首次用两组 fixture 模型、150 天历史确认形状和密度；配色与微弹验证扩为六组 fixture 模型，覆盖五种模型色、其它类别、零值日、不同柱高。未修改正式数据库或真实用量记录。两轮 fixture 不同，不把两轮图片声称为同数据逐像素比较。
- 截图来自运行中的 Electron；微弹视频为 macOS 对该隔离实例窗口的约 6 秒真实录屏，非设计稿、SSR 或模拟图表。最终代码 SHA、生产文件 blob ID 与附件 hash 记录在附件 manifest 和 PR 正文；公开附件链接待上传后回填。
- 800px 窗口：形状修复前柱图区 807px，可见区域约 410px；修复后 30 柱绘图区 clientWidth/scrollWidth 均为 410px，静止单柱约 10.77px，无逐柱最小宽度撑开。热力格静止 12×12px，四角始终 2px；日期输入 190×36px，提交按钮高 36px。
- 09-08 参考图微调后的配色实测：Light 五色为 rgb(20,184,166)、rgb(244,63,94)、rgb(139,92,246)、rgb(99,102,241)、rgb(245,158,11)；Dark 对应 rgb(45,212,191)、rgb(251,113,133)、rgb(167,139,250)、rgb(129,140,248)、rgb(251,191,36)。颜色定义只在 colors.ts，本文为本轮 computed 取样。模型表色块与同一模型柱段一致，“其它”为中性灰；替代前轮进程色别名的柱图样本，热力图蓝色保持不变。
- Light/Dark 动效逐帧实测：柱宽约 10.77→12.77px，采样最大增量约 2.08px，小于 3px 间隙；柱高、基线、分段颜色、2px 圆角、点击框尺寸全程不变。选中后移走鼠标仍保持放大。热力格选中后 14×14px，点击框仍为 12×12px，四角仍 2px。
- 交互验证：点击热力格、点击柱体、填写日期并提交得到同一筛选结果；编辑草稿不提前筛选。键盘 Tab/Enter 的可达、焦点轮廓和筛选已实测，原有 Space 原生语义保留。减少动态效果时 computed transition-duration 为 0s，选中/焦点反馈仍可见。原生 tooltip 保留在可命中的日期按钮上，避免放大层的 pointer-events 设置吞掉提示。
- 参考图反馈复核：最初 fixture 每 7 天固定零值恰逢星期六，导致最后一行全空；本轮只重分布隔离模拟数据的零值日期，150 天中 130 天非零，七个星期行均有数据（星期六 18 天非零）。生产日期排列和零值判断未改。新旧 fixture 不同，不作同数据视觉对比。
- 无框选中实测：Light/Dark 鼠标选中轮廓均为 0px，选中柱 opacity=1，其余柱为 0.24；热力图 opacity 始终为 1。选择柱图窗口外的历史日期时，所有柱恢复 opacity=1。键盘焦点轮廓仍为 2px，三个日期入口等价检查继续通过。
- 非交互分支由组件单测覆盖；当前源码未找到旧 HomeUsageDashboard 的运行期挂载入口，因此未伪造首页实机验收。Windows/Linux 实机与屏幕阅读器未验证。
- 栅格与录屏不入仓。附件在工作区忽略目录 `.cindy/usage-chart-evidence-2026-09-08/`；最新文件以 `refined-` 开头；`color-` 是已被本轮配色和无框选中处理取代的前轮样本，旧 `before-` / `final-` 为首轮几何证据。PNG、MOV、JSON 均待人工上传至 PR 评论并回填稳定链接；尚无公开附件时，不记为证据交付完成。
- **人工视觉验收：待所有者批准最终实机效果。** 09-08 已确认的是设计方向；作者采集、测试和自审不替代视觉批准，整个 `desktop.settings` surface 不记为 migrated。

## 2026-09-08 后续本地交互预览（未提交）

基于 `fce51fa28647a1fe2d9ddb46740dd5fa0991405e` 加当前工作区改动，不能将下述图片标为该提交自身的证据。新增日期入口已取消，最终命中方案尚未裁决，当前预览不表示可合入。

- 热力图恢复蓝色；选中可见层 14×14px，指示层同宽高，1px 描边、1px 间隙。Light 描边 computed 为 rgb(26,26,26)，Dark 为 rgb(212,212,212)。柱图仍无鼠标选中外框。
- 实际操作时间范围下拉选择最近 7 天：最近七个日历日强调（含零值），其余柱 opacity=0.6；没有七个 aria-pressed 单日选中，所有柱高保持原样。单日筛选仅强调对应柱；热力图选择图外日期后，柱图 selected/highlighted 均为空、opacity 全部为 1。
- Light/Dark 的范围、单日、图外日期与键盘焦点均已实测。21 个定向测试及 Desktop typecheck 通过；本轮未执行完整提交门禁，也未提交/推送。
- 新预览附件为 `interaction-light/dark-week.png`、`interaction-light/dark-selected.png`、`interaction-light/dark-outside.png` 及同名前缀实测 JSON，位于既有忽略目录；工作区 blob/hash 记录在 `interaction-preview-manifest.json`。旧 `refined-*` 为此前提交证据。最终视觉验收待所有者完成。
<!-- Local typography preview, 2026-09-08 (uncommitted): settings-aligned size
hierarchy documented in usage-history-charts.md. Electron Light/Dark inspected;
page-scoped font tokens temporarily enlarged from UI size 14 to 18 and restored,
without changing user preferences. Summary values did not overflow horizontally.
11 targeted tests including typography discipline passed; desktop typecheck and
git diff --check passed. No commit, full related gate or DCO run for this preview.
Target sizing remains unresolved; human visual approval remains pending. -->
