# DS-4 证据 · 2026-09-04

- 分支：`ds/4-button-input-primitives`
- 基点 SHA（开工时 `origin/main`）：`c4033acd07910b9b3c993772589dcda877188fb1`
- 采集 commit（产生下表色值与全部截图的代码状态）：`0458af96d`（工作分支
  `feat(design-system): DS-4 Button 与 Input 标准组件`，2026-09-04 18:44）。
  该提交随分支 squash 合入 #3920（`ede0f7739`）。两个 SHA 之间决定按钮/输入颜色的
  `themes/` 与 `components/ui/`（除 `input.tsx` 的调用方 style 合并次序外，采集后改的、
  与色值无关）完全一致——检出任一者复核均可复现下表。基点 `c4033acd` 只是开工坐标，
  **不含** DS-4 改动，不能用于复核。
- 平台：Desktop
- 实机沙箱：`CindyGlobal-dev2-ds-4-button-input-fcdc92`，`node scripts/desktop-whoami.mjs` 报 MATCH 本 worktree
- 主题：CINDY Light 与 CINDY Dark（均为实机采集）

> **截图不在本目录**。按治理合同 §6（2026-09-05 收口），栅格证据一律走 PR 附件、不入仓；
> 本文件是可复核的**文本索引**。
>
> DS-4 的实机截图当时是在隔离沙箱里直接给设计师看的实时画面，批准记录见下方「有意可见差异」
> 各条的日期。它们曾随 #3920 入仓，已由本 PR 从 tip 移除（历史不重写，见 §6）。
> 12 张图的存放入口：PR #3931 证据评论（[issuecomment-5544942109](https://github.com/makecindy/cindy/pull/3931#issuecomment-5544942109)），
> 评论内附逐图清单；附件本体因 GitHub 图片上传端点只支持网页会话（`gh` CLI 与 REST/GraphQL
> API 均传不了图），需人工在 PR 评论框拖拽上传后把链接编辑进该评论——上传完成前，该评论
> 是清单占位、尚未含图。原始字节始终可从 #3920（`ede0f7739`）的 Git 历史恢复。
> 下表的 computed style 色值即证据本体，同环境重跑探针可复核。

## Level 2 实机逐格

对真实运行的 Desktop 用 CDP `CSS.forcePseudoState` 强制伪类后裁剪截图，`background-color`
取自 `CSS.getComputedStyleForNode`。目标是 `设置 → 模型供应商 → OpenAI` 详情里的
「断开」按钮，即 `ui/button` 的 `variant="secondary"`。

下表的色号就是可复核的证据本体——同环境重跑探针应得到同样的值。

| 主题 | rest | hover | pressed | disabled + hover |
| --- | --- | --- | --- | --- |
| CINDY Light | `#FDFDF8` | `235,235,230` | `214,214,210` | `#FDFDF8`（不变） |
| CINDY Dark | `#1F1F1F` | `45,45,45` | `62,62,62` | `#1F1F1F`（不变） |

两条要点：

- **暗色梯度成立**。修复前 CINDY Dark 的 secondary hover 距 rest 只有 2/255，实测已拉到 14。
- **禁用态悬停不再换色**。`disabled + hover` 回到 rest 值，证明 `enabled:` 前缀生效。

`variant="primary"` 在本张没有生产消费者（`PillButton` → secondary、`CtaPillButton` → cta），
因此没有实机格；它由 Level 1 的 11 主题状态梯守卫覆盖。`cta` 的实机格需要 XD 资产模块
处于可购买态，本次沙箱未构造出该状态。

## 当时看过的图（不入仓，附件入口见证据评论）

12 张图的存放与逐图对照统一放在 PR #3931 的证据评论
（[issuecomment-5544942109](https://github.com/makecindy/cindy/pull/3931#issuecomment-5544942109)），
评论内附每张图的文件名清单；附件本体需人工拖拽上传（原因见上方引言），
上传前该评论为清单占位。下表登记每张图的用途：

| 图 | 内容 |
| --- | --- |
| 实机 · 设置 → 模型供应商 | 搜索框为 `ui/input`；Anthropic「去授权」为 secondary |
| 实机 · 添加供应商向导 | 授权 / 改用 API Key / 取消 三颗 secondary |
| G5 同值性对照 | 现状灰底 / 规范白底 secondary / 规范灰底 primary，Light 与 Dark 并排 |
| 逐格特写 × 8 | CINDY Light / Dark 各 rest / hover / pressed / disabled+hover；数值见上表 |

另有一张「设置 → 通用」实机图，含账号邮箱与组织信息，**从未入仓也不外发**——本仓公开，
个人数据不进 Git 历史。它当时的作用是展示退出登录 / 登录更多账号两颗 secondary，
已由上表第一、二项覆盖同一变体。

初版还画过一张默认主题 token 对照图（`ds4-button-input-state-matrix.png`，绘制的、
非实机），其 hover / pressed 色号按**修复前**的绑定绘制，已不代表现行实现；为完整性
一并放进证据评论，但**不作为色值证据**，现行值以上面的实机测量表为准。

## Level 1 静态守卫

| 守卫 | 锁什么 |
| --- | --- |
| `themes/__tests__/buttonStateContrast.test.ts` | 11 个内置主题 × 3 变体，rest → hover → pressed 每档 ΔRGB ≥ 8；含自证伪（把 hover 换回撞色的 `--surface-hover` 必然红） |
| `components/ui/__tests__/button.test.tsx` | 变体 token 合同表、胶囊圆角、text-13/500、尺寸只两档、禁用态无裸 `hover:`；含自证伪 |
| `components/ui/__tests__/input.test.tsx` | fill / text / placeholder / focus token、三档高度、ivory variant、error 态、secret 显形；含自证伪 |
| `packages/design-tokens` classification | 5 个运行期派生状态值必须登记为 `runtime-derived-or-protected`（治理合同 §3.4） |
| `themes/__tests__/desktopColorDefaultsFreeze.test.ts` | DS-2b 快照与实时注册逐值一致 |

## 有意可见差异（设计师已批）

1. **G5 secondary 统一成白底**：设置页 `PillButton` 从 `--settings-btn-secondary-*` 改绑
   `--surface-elevated`。CINDY Light 下与卡片同色，读成空心描边。用户 2026-09-03 看默认
   主题对照后选统一成白底，2026-09-04 看实机后确认「可以，没问题」。
   （实机批准时还看了「设置 → 通用」的退出登录 / 登录更多账号两颗按钮；该截图含账号邮箱与
   组织信息，从未入仓也不外发。同一按钮变体的证据由供应商页与向导两张覆盖。）
2. **G2 Cta hover**：私有原型 `hover:opacity-90` 换成换色。文字不再跟着变淡。
3. **状态梯改为派生，hover 8% / pressed 10%**：用户 2026-09-04 批准。取代 09-03 原定的
   「从 `--surface-hover` 族现值取」——那样在 4 个暗色主题里状态不可区分。落地时比例尚未
   获批、事后补批，该流程越界已记入 `design-decision-log.md` 09-04 条。

## 次要差异（2026-09-04 已逐项裁决，详见 decision-log 同日条）

1. **输入框禁用态 60% 不透明度 —— 保留。** 全仓 19 个输入调用点只有 1 个会传 `disabled`
   （Agent 资源占用的「并发命令上限」，仅预设写盘在途）。该输入框改造前就已传 `disabled`
   却无视觉表现，而同 section 的预设按钮改造前就带 `opacity-60` —— 本项是补齐同屏不一致，
   不是新增观感。CINDY Light 合成值：边框 `#E4E4DF`→`#EEEEE9`、数字 `#1A1A1A`→`#757573`。
2. **`ui/input` 保持绑 Tier-1 —— 不回退域 alias。** 分裂只在「新建本地副本」导出型本地主题
   下可见（导出把 520 个 token 全部展平成字面量）；导入型 VSCode / Obsidian 主题零影响。
   该断层线既存：全仓直接读 `border-default` 513 处 vs 读 `settings-input-border` 138 处，
   DS-4 只是把 6 个调用点挪到人多的一侧。138 处收口已登记为 **DS-5 待办**（台账
   `desktop.settings` 下一动作）。

## 缺口如实登记

- `variant="primary"` 与 `cta` 无实机逐格截图，原因见上。
- 「声明零视觉的迁移逐像素一致」**未做**，且本张已不适用：secondary 换白底、输入框禁用态
  两处都是真实视觉变化，已在上面逐条列出，不再声称零视觉。
- `DESIGN.md §4` 单行输入 focus 环的 spec 与实现不一致，登记进
  `design-governance.md §10` 待裁决表，本张不擅自统一。
