# DS-4 证据 · 2026-09-04

- 分支：`ds/4-button-input-primitives`
- 基点 SHA（开工时 `origin/main`）：`c4033acd07910b9b3c993772589dcda877188fb1`
- 平台：Desktop
- 实机沙箱：`CindyGlobal-dev2-ds-4-button-input-fcdc92`，`node scripts/desktop-whoami.mjs` 报 MATCH 本 worktree
- 主题：CINDY Light 与 CINDY Dark（实机）+ 默认主题 token 对照图

## Level 2 实机逐格（`cells/`）

对真实运行的 Desktop 用 CDP `CSS.forcePseudoState` 强制伪类后裁剪截图，`background-color`
取自 `CSS.getComputedStyleForNode`。目标是 `设置 → 模型供应商 → OpenAI` 详情里的
「断开」按钮，即 `ui/button` 的 `variant="secondary"`。

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

## 其余文件

| 文件 | 内容 |
| --- | --- |
| `live-settings-providers.png` | 实机：设置 → 模型供应商 |
| `live-add-provider-wizard.png` | 实机：添加供应商向导 |
| `ds4-g5-secondary-compare.png` | G5 同值性对照：现状灰底 / 规范白底 secondary / 规范灰底 primary |
| `ds4-button-input-state-matrix.png` | 默认主题 token 值对照图（画的，非实机） |

⚠ `ds4-button-input-state-matrix.png` 是 2026-09-04 上午按**修复前**的 token 值画的，
其中的 hover / pressed 色号已不代表现行实现；现行值以上表实机测量为准。保留它是为了
留下「初版为何看不出暗色缺陷」的痕迹。

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
   组织信息，**不入库**——本仓公开，个人数据不进 Git 历史。同一按钮变体的可入库证据见
   `live-settings-providers.png` 与 `cells/`。）
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
