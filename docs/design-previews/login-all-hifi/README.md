# login-all-hifi — 登录链路「全端」高保真可交互 QA demo

桌面 / 手机 phone / 平板 pad 三端 × 全状态的单文件可交互 demo，本轮**追平当前产品**后随 PR #908 入库。

- **内网体验地址**：<https://login-all-hifi.workers.xd.team>（仅公司内网；页面没刷新是 CDN 缓存，URL 后加 `?v=<时间戳>`）
- **本地打开**：浏览器直接打开本目录 `index.html`（自包含，无需起服务）
- 上游 review 的 UI 证据入口是本目录的 [`index.html`](./index.html)（仓内 `.html` 链接）；内网地址作为体验入口

## 本轮改了什么（demo 追平产品）

本 demo 建于 2026-07-27，主题是当时那条**登录改版**分支。其移动端部分后来**未进 `main`**，
所以 demo 与产品一度对不上（提取器直接崩，门 A 必红）。本轮按当前产品源码逐项追平：

| 轴 | demo 原状 | 追平为 | 来源 |
|---|---|---|---|
| 移动「跳过登录」入口 | 面板内文字按钮 + 2 状态 + 18 条绑定 + 热区自检 | **整条移除**（产品决定：远程连接客户端必须有账号；桌面 `SKIP_ENTRY` 仍在，两端不对称是产品事实） | 范围纠正 |
| 移动面板 / 组高 | 面板 500 / 组 620 | **面板 440 / 组 560**（协议行 642→582、圆钮行 540→480、error 槽 50→60） | 同上 |
| 移动键盘停靠锚 | error 槽底 430（该常量产品已无） | **面板底**（产品 `login.tsx`：`panelBottomY = groupBaseline.y + loginSizes.panelHeight × groupScale`），12 组键盘态数值全部重算 | 同上 |
| 窄屏落位公式（`dh<1334`） | `max(0, dh-640)` | **`min(short.loginY, max(0, dh-640))`** —— 钳到短屏档 622，避免面板压盖字标 | PR #908 |
| pad 竖屏落位 | 573.35 | **621**（随短屏档同源联动） | PR #908 |
| 桌面区域徽标 | 全区域标 `Global`，固定宽 70 | **`global` 不标 / `cn`·`dev` 才标**（文案 `login.regionPill.{cn,dev}`），宽度由 `paddingX` 撑开（token 无 `width`） | 主干 #554 |

短屏 / 长屏两档的 `loginY` 本来就是稿内值 **622 / 827**（07-27 分支已是新稿基准），
PR #908 做的是在 `main` 上把它恢复并补齐窄屏钳制 —— 详见 `docs/design-rules/DESIGN.md §16.2`。

## 验收（`report.json` 为脚本产出，禁手改）

| 门 | 结果 |
|---|---|
| **A** 真值一致 | pass，`extractorDrift = none`（现跑 `extract.mjs` 的输出 ≡ `truth.json` ≡ `index.html` 内嵌块） |
| **B** 状态覆盖 | pass **474 / 474**（79 态 × 6 组合，`via` 链路重放后真断言 `__qa.current()`） |
| **C** 交互鲁棒 | pass（文案零截断扫描 + 2 项输入跨定时 tick 焦点不丢 + 偏好持久化 reload 恢复） |
| **D** 渲染绑定 | pass **924 / 924**（154 条绑定 × 6 组合，`getComputedStyle` 逐条核对色值 / 长度 / 文案 / 资产 sha） |
| **F** 适配还原 | pass **11 / 11**（10 个采样尺寸 + 最小宽高钳制；oracle = 产品公式预计算） |
| **E** 像素基准 | **未比对**（无真沙盒基准图，如实标注） |

## 真值来源（禁手抄）

`truth.json` 每个叶子都带 provenance（产品文件路径 + hash + locator），由 `extract.mjs` 机械提取：

- **布局常量**：`apps/desktop/.../loginDesignTokens.ts`、`loginScale.ts`、`apps/mobile/src/auth/loginSkinLayout.ts`、`apps/mobile/src/theme/tokens.ts`（经 esbuild 编译后 import，取真值而非正则猜）
- **布局 oracle**：直接调产品公式本体 —— `resolveLoginSurface()` / `computeLoginKeyboardShift()` / 桌面 `loginScale` —— 对 `spec.adaptive.sampleSizes` 与四个移动帧预设**预计算**期望几何；demo 侧用镜像公式独立算一遍，由门 D / F 比对两次独立计算
- **五语文案**：`JSON.parse` 桌面 5×`common.json` + 移动 `loginMessages.ts`
- **色 token**：正则解析 `themes/colors.ts` / 移动 `theme/tokens.ts` 的 light / dark 对
- **SVG path**：从 `LoginControls.tsx` / `LoginSkinControls.tsx` 逐函数提取 `d` / `fill` / `viewBox`
- **品牌位图**：`assets/` 是产品 PNG 的**逐字节拷贝**（与 `apps/mobile/assets/login/`、`apps/desktop/src/renderer/assets/login/` 完全相同，git 复用同一 blob），`truth` 记录 sha256 + IHDR 尺寸，门 D 的 `asset-sha` 绑定按 sha 比对

## 复现 / 更新

在**仓库根**执行（Node 22+）：

```bash
S=~/.claude/skills/qa-hifi-demo/scripts
D=docs/design-previews/login-all-hifi
node $S/truth.mjs  --demo $D --check    # 漂移检查:产品动了但 demo 没跟 → exit 2 + 差异清单
node $S/truth.mjs  --demo $D            # 重新提取 truth.json
node $S/truth.mjs  --demo $D --embed    # 写回 index.html 的 qa-truth 内嵌块(禁手抄；须保留 const RAW 静态字面量包装)
node $S/states.mjs --demo $D            # 静态:状态声明完备性
node $S/verify.mjs --demo $D            # 动态:门 A/B/C/D/F(约 9 分钟)
```

产品登录相关常量 / 文案 / 组件变更后跑 `--check`；漂移就重走上面五步，别手改 `truth.json` 或内嵌块。

`index.html` 把生成后的 truth 作为 `const RAW = {...}` 静态字面量直接执行，而不是先从 DOM
`textContent` 读回再交给 HTML 渲染器。这个包装是预览页的安全边界；`pnpm test:runner` 会同时
校验包装形态与 `truth.json` 的结构等价，更新嵌入工具时不得退回 DOM 文本数据源。

> ⚠️ **`report.json` 当前已过期（2026-08-09）**：它是 2026-07-29 的四语快照，`inputHashes` 与
> `coverage.cases` 都早于本次繁中登录覆盖，其 `ok: true` 不代表当前五语工件已通过门 A–F。
> `truth.json` 与内嵌块已由 `extract.mjs` 机械刷新，并确认 41 个 provenance 源文件的 hash
> 全部匹配；但 `verify.mjs` 所在的 qa-hifi-demo 工具链未入仓且本机没有，所以不伪造新报告。
> 在有工具链的环境重跑 `verify.mjs` 并提交刷新后的 report 即可解除标记。

## 局限（如实说明）

- **静态渲染，不是真机截图**：按设计坐标系换算的 HTML 复刻，非 Electron / RN 实机产物；
  门 D 保证「渲染层 CSS ≡ truth」，门 F 保证「拉伸行为 ≡ 产品公式」，但**像素级未与沙盒比对**（门 E 无基准）。
- **移动端为镜像实现**：HTML 与 React Native 无同构映射，`mobSurface()` 是对 `resolveLoginSurface()`
  的逐式镜像，两边独立计算、由门 D / F 交叉验证 —— 不是同一份代码。
- **键盘态是仿真**：真机 `keyboardDidShow` 的高度 / safe-area 由 `truth.mobile.keyboardSim` 声明的
  仿真输入给出，位移公式取产品 `computeLoginKeyboardShift()` 预计算值；不代表任何具体机型实测。
- **门 B / D 走 6 组代表性组合**（`spec.verify.cases`），覆盖全部五种语言，不是 3×2×2×5 全笛卡尔积 —— 全展开会慢到不可用。
  未覆盖的组合由「同一套 truth + 同一套渲染代码」承担，不等于逐组验过。
