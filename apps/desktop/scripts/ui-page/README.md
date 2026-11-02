# 单页 UI 快速验证

只编译要看的真实 renderer 组件，在隔离窗口里按场景渲染、检查、截图后退出。不启动 Forge、
Vite、main、登录、数据库、模型或插件，也不碰正式 Cindy 的数据。适合 Agent 在改完界面后
自检，以及人工快速看一个页面。何时用它、何时必须回到完整 Desktop，见
[`desktop-development.md`「按改动选择验证方式」](../../../../docs/dev-rules/desktop-development.md)。

```sh
pnpm ui:check --changed --theme all                      # 本分支改动涉及的页面，全部场景
pnpm ui:check --page device-picker --locale all          # 五种语言
pnpm ui:check --page group-chat --case all --theme all --viewport 720x600,1280x800
pnpm ui:check --page group-chat --case long-device --compare        # 改前／改后对照
pnpm ui:check --page group-chat --case long-device --focus '[data-controlled-banner-chip]'  # 放大看一个元素并量尺寸
pnpm ui:check --entry tmp/my-card.tsx --case all         # 还没注册的组件
pnpm ui:check --list                                     # 已注册页面与场景
pnpm ui:preview --page group-chat --case long-thread     # 人工验收：保持窗口，改文件自动重载
```

## 读结果

```
UI_CHECK failed 9/10 variants · 6.1s (build 2246ms, launch 232ms)
overview: artifacts/ui-check/group-chat-xxxx/overview.png
page group-chat: real — BotGroupChatView, ControlledBanner, …
  not covered — Sending, round control, …
  replaced — none
FAIL group-chat.no-sidebar.dark.zh-CN.1280x800
     error: …
     host APIs read but not provided: maker.listBotGroupPlans
```

- 每个变体 id 是 `页面.场景.主题.语言.宽x高`。退出码：0 通过，1 有变体失败，2 参数错误。
- **先看 `overview.png`**：截图按变体排列，每张最多 6 个变体，更多的写到 `overview-2.png`
  等并在首行列出；`--compare` 时同一步骤的改前／改后并排。命令通过只代表断言和通用检查
  通过，视觉是否合理仍要看图。
- 改动集中在一个元素（间距、截断、对齐）时加 `--focus <CSS 选择器>`：每次截图另存该元素
  周围的 2 倍放大图（`*.focus.png`），overview 只放这些放大图，报告逐行给出元素尺寸、
  padding、gap、字号／行高／字重和被裁切的子元素数；与 `--compare` 一起用时改前数值同时
  列出，可以直接比对。元素在某次截图时不存在会跳过，全程都不存在才给警告。
- 截图按 2 倍像素密度渲染（与 Retina Mac 一致，不随外接显示器变化），整页截图按 CSS
  尺寸保存。
- 后台检查使用无边框窗口，Windows 额外启用离屏渲染，避免原生边框的 DPI 取整和隐藏
  窗口不刷新导致尺寸偏差或截图超时；仍严格核对实际视口与目标尺寸。`ui:preview` 保留
  正常的可见窗口。
- Electron 复用隔离进程，每个场景新建窗口，防止前一场景的 CDP 视口、全屏或失败状态
  污染后续检查。测试源仅允许 HTML 全屏，后台运行不改变系统全屏状态，其它权限仍拒绝；
  系统全屏切换需在完整 Desktop 验证。
- 报告写到 stdout。环境里设置了 `NODE_DEBUG` 时 Node 会往 stderr 刷调试日志，用
  `env -u NODE_DEBUG pnpm ui:check …` 或丢弃 stderr。
- `real` 是本页面真实加载的产品代码，`not covered` 是这些场景没有验证的行为，`replaced`
  是被场景替换掉的模块（替换的模块本身没有被验证）。
- 证据目录只保留最近 20 次运行；`summary.json` 有每个变体的截图、错误、警告、耗时、宿主缺失
  接口和 Electron／Chromium 版本，`--json` 直接输出它。

每次截图（`initial`、`check` 里的 `ui.capture`、`final`）时都会自动检查，出现以下情况判为失败：

- 页面报错、控制台 error、尝试访问测试源以外的网络；
- 横向溢出；
- 界面上出现原样的翻译 key；
- 调用了场景用 `forbid()` 声明为禁止的宿主写接口。

以下只给警告：文字被裁切、截断文本没有 `title`、当前语言缺少翻译而回退到其他语言。

## `--changed` 的覆盖含义

`--changed` 读取相对上游主干的改动（含未提交和未跟踪文件），选出真实加载了这些文件的页面，
默认跑全部场景：

- `loaded` 文件被某页面加载；全局样式及其引入的样式文件、Tailwind 配置算作每个页面都加载。加载不等于被渲染到，具体分支是否出现取决于场景。
- `STUBBED` 文件在该页面里被替换，等于没验证。
- `UNCOVERED` 是 renderer 里没有任何页面加载的界面文件，**未被验证**：补一个场景、用
  `--entry` 临时挂载，或在完整 Desktop 里验收。

## 发 PR 时带图

每次检查都会在输出目录写 `pr.md`，报告里有一行 `pr:` 给出路径。内容对应 PR 模板「UI 变化」：
截图来源（命令、平台、Electron／Chromium 版本，注明是场景数据）、版本与是否含未提交改动、
通过情况、每个页面的场景与未覆盖行为、被替换的模块、改前／改后对照、`--focus` 实测数值
（改前 → 改后）、未通过的场景和 `--changed` 没覆盖到的文件。

发 PR 前运行 `pnpm ui:check:publish`（默认取最近一次运行，也可以传运行目录）：

- 把该次运行的 `overview*.png` 作为一个提交推到作者 fork 的 `pr-assets/<当前分支>`。提交只含
  截图、不与产品历史相连；同一分支多次发布时依次追加，旧链接继续有效。不改工作区、索引和
  当前分支，截图不会进入上游仓库；目标远端就是 PR 的目标仓库时直接拒绝。
- 输出 `pr.published.md`：`pr.md` 加上按提交 SHA 固定的图片链接，原样写进 PR 正文「UI 变化」。
- 默认推到第一个不是上游仓库的 GitHub 远端（通常是 `origin`），可用 `--remote`／`--branch`
  指定；`--dry-run` 只生成内容不推送。

普通界面改动用这些截图即可。登录、发送、跨设备等单页验证覆盖不到的变化，仍附完整 Cindy
截图；设计系统 PR 的证据要求见
[`design-governance.md` §6](../../../../docs/design-rules/design-governance.md)。

## 多语言、主题与尺寸

`--locale` 取自 `src/shared/locale.ts` 的 `SUPPORTED_LOCALES`，`--theme` 为 `light`／`dark`，
都可以写逗号列表或 `all`；`--viewport` 可以写多个尺寸。所有组合在同一个隔离进程中依次运行。
语言和主题按产品启动时的同一套偏好写入（`localStorage` 的 `theme` 与语言偏好），字体使用产品
自带的 Inter、JetBrains Mono 与鸿蒙黑体子集。断言里不要写死某种语言的文字，用 `ui.t(key)`
取当前语言的翻译。

## 场景与数据模拟

注册页面放在 `apps/desktop/scripts/fixtures/<名>/ui-page.mjs`，会被自动发现：

```js
export default {
  name: 'device-picker',
  entry: './device-picker-fixture.tsx',     // 调用 mountPage() 的入口
  viewport: { width: 1040, height: 520 },
  real: '真实加载的组件',
  notCovered: '这些场景不验证的行为',
  stubs: { /* 见下 */ },
  cases: {
    default: { about: '一句话说明场景', data: { /* 传给页面的 JSON */ } },
    'long-name': { about: '…', data: { … }, viewport: { width: 800, height: 600 } },
  },
  async ready(page) {},                      // 可选：截图前等待
  async check(page, ui) {},                  // 可选：交互与断言
};
```

入口里用 harness 挂载真实组件：

```tsx
import { AppFrame, ctx, forbid, mountPage, subscription } from '../../ui-page/harness';

mountPage({
  route: '/bots/group/fixture-group', // 可选：MemoryRouter 初始地址
  host: (ctx) => ({
    // window.electronAPI 的场景数据
    maker: {
      getBotGroup: async () => groupFrom(ctx.data),
      onBotGroupChanged: subscription('botGroupChanged'),
      sendBotGroupMessage: forbid('maker.sendBotGroupMessage'),
    },
  }),
  render: (ctx) => (
    <AppFrame>
      <BotGroupChatView />
    </AppFrame>
  ),
});
```

数据按从轻到重三种方式提供，优先用前一种：

1. **宿主接口（`host`）**。页面代码通过 `window.electronAPI` 读取数据时，直接在场景里给出。
   没给出的接口读取为 `undefined` 并记录到 `host APIs read but not provided`，页面失败时据此
   补数据。会改动用户数据的接口用 `forbid(name)` 声明：调用即失败。推送事件用
   `subscription(name)`，在 `check` 里用 `await ui.emit(name, payload)` 触发。
2. **`ctx.data`**。场景的 `data` 原样传给入口，用于组件 props 或宿主数据。
3. **模块替换（`stubs`）**，只在 store 或 hook 无法经宿主接口喂数据时使用。键是相对
   `apps/desktop` 的模块路径（不带扩展名）：
   - 字符串：整个模块换成这段代码；
   - 以 `./` 或 `../` 开头的字符串（如 `'./x.ts'`）：换成场景目录下的这个文件；
   - `{ partial: '…' }`：保留真实模块，只覆盖其中几个导出。

   被替换的模块会列在报告的 `replaced` 里，不算被验证。

`AppFrame` 复刻主界面的侧栏（默认 260px）与内容区结构，并挂载真实的 `ContentHeaderSlot`，
让页面在真实宽度和标题栏里排版；不需要外框时直接渲染组件。

`check(page, ui)` 里的 `page` 是 Playwright Page。`ui` 包含当前变体
（`case`、`theme`、`locale`、`viewport`、`data`）以及：

- `ui.capture(name, { locator })`：额外截图；
- `ui.t(key, values)`：当前语言的翻译；
- `ui.emit(name, payload)`：推送事件。

每个变体都自动截 `initial`；有 `check` 时结束再截 `final`。

### 临时入口

还没注册的组件，写一个调用 `mountPage()` 的文件即可，放在 Git 忽略的 `tmp/` 下：

```tsx
import { mountPage } from '../apps/desktop/scripts/ui-page/harness';
import { Switch } from '../apps/desktop/src/renderer/components/ui/switch';

mountPage({ cases: ['off', 'on'], render: (ctx) => <Switch checked={ctx.case === 'on'} /> });
```

`pnpm ui:check --entry tmp/switch.tsx --case all --theme all` 运行声明的全部场景，只做通用检查和
截图。组件会反复回归时，再注册成页面并写 `check`。

## 改前／改后对照

`--compare [<ref>]` 把本页面加载的产品源码、样式、翻译与图片字体（`apps/desktop/src`、
`apps/desktop/resources`、`packages` 下的脚本、CSS、JSON 与资源文件，含全局样式）换回 `<ref>` 的版本再渲染一次，此后移动或删除的文件也按 `<ref>`
补回；不写 `<ref>` 时用本分支与上游主干的分叉点，也就是“本分支改动之前”。场景与
harness 始终用当前版本，所以两边执行同样的步骤、截同样的图。没有文件不同时不重复渲染。
改前一侧的断言失败不影响结果，在报告里以 `before <ref>:` 开头逐条列出；`<ref>` 之后才新增的文件按当前版本使用并列出。
Tailwind 配置由 Tailwind 直接从磁盘加载，两侧都用当前版本；它在 `<ref>` 之后有改动时报告会写明。

## 运行方式

- 默认 `--engine electron`：仓库里的 Electron，与 Cindy 同一个 Chromium。每次运行使用新的
  临时 profile、拒绝权限与下载、只允许访问测试源，运行完删除临时数据；后台检查不显示窗口、
  不占 Dock。
- `--engine chromium`：Playwright Chromium 或本机 Chrome（`--browser <路径>` 指定）。
- `--timeout` 是每个变体的超时（默认 20 秒）；超时后场景不能再截图。Electron 各变体共用一个
  窗口，超时的场景仍在运行时本次检查直接停止，避免它操作后面的变体。Ctrl+C 会写完
  `summary.json` 并关闭窗口。
- `--platform` 默认是当前电脑的平台；指定其它平台只改变页面读到的 `electronAPI.platform`，
  报告会写明模拟的平台。
- `ui:preview` 只用于人工验收：显示一个窗口，依赖的源码、样式、翻译或场景变化后自动重载，
  关窗或 Ctrl+C 结束。自动检查不要用它保持窗口。修改运行器、依赖或 Tailwind 配置后重启命令。

## 维护

运行器自身的回归：`pnpm ui:check:selftest`（node:test，会打开 Electron，不属于 `test:unit`）。
覆盖页面报错、外网请求、禁止写入、宿主缺失记录、原样翻译 key、超时与中断后的清理。改动
`ui-page/` 后运行它，并跑一遍已注册页面。
