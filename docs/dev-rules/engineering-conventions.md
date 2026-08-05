# 通用工程规范（Desktop / 客户端）

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、
> 跨平台（macOS／Windows）相关行为、任何 UI 文案的 i18n 落地，或新增／修改动画与
> 界面加载时序等渲染性能相关行为之前

本文收拢一组适用于整个客户端的通用工程约束。IPC 的安全与授权边界另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
UI 文案的语气与措辞另见 [`DESIGN.md`](../design-rules/DESIGN.md) 的 Voice & Content 一节，验证命令
见 [`desktop-development.md`](desktop-development.md)。

> **增量适用原则**：本规则约束新增和正在修改的代码，不要求为统一形式专项重构存量。
> 编辑既有代码时顺手对齐碰到的违规即可，不主动批量 grep 改造。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 统一日志模块 | `apps/desktop/src/main/logger.ts`（main）、`apps/desktop/src/renderer/lib/logger.ts`（renderer） |
| dev 日志目录 | 启动 checkout 的 `apps/desktop/logs/` |
| IPC 错误码枚举 | `apps/desktop/src/shared/ipc-errors.ts`（`IpcErrorCode`） |
| `throwIpcError` 实现 | `apps/desktop/src/main/utils/ipcValidate.ts` |
| Renderer 侧错误解码 | `apps/desktop/src/renderer/utils/ipcError.ts`（`extractIpcError`、`mapIpcErrorToI18nKey`） |
| 支持的语言与默认语言 | `apps/desktop/src/shared/locale.ts`（`SUPPORTED_LOCALES`、`DEFAULT_LOCALE`） |
| i18n 资源 | `apps/desktop/src/renderer/i18n/locales/<locale>/common.json` |
| i18n key 一致性门禁 | `scripts/check-i18n.mjs`（`pnpm check:i18n`） |
| **术语表（唯一事实源）** | `i18n/glossary.json`，人读版 `i18n/GLOSSARY.md` |
| 术语一致性门禁 | `scripts/check-i18n-glossary.mjs`（`pnpm check:i18n-glossary`） |

## 1. 日志

- 所有日志输出走统一日志模块，不要裸 `console.log`。
- dev 排查 bug 时，若问题能靠日志定位，优先在可疑路径加 DEBUG 级日志（走统一 logger），
  让用户复现一次后去日志目录定位。日志目录是启动 checkout 的 `apps/desktop/logs/`：先用
  Glob／ls 列出当前文件（文件名与 rotate 后缀会变），再读相关文件；cwd 不在仓库根时先
  确认仓库根再拼绝对路径。
- 问题确认后清掉临时排查日志，不要把它们留在仓库里。

## 2. IPC 错误协议

- main 进程 IPC handler 的错误必须用 `throwIpcError(code, message)`，禁止裸
  `throw new Error('xxx')`，也不要用 `return { ok: false, error: '...' }`。
- `code` 必须来自 `ipc-errors.ts` 的 `IpcErrorCode` 字面量联合，违规会被 typecheck 拦下；
  确需新 code 时先扩枚举，不要在调用点用 `as IpcErrorCode` 强转绕过。
- Renderer 端消费 IPC 错误统一走 `renderer/utils/ipcError.ts` 的 `extractIpcError` /
  `mapIpcErrorToI18nKey`，不要手写 `err.message.match(/\[XXX\]/)` 解码——跨进程序列化会丢
  `Error.code` 字段，协议靠 `[CODE] message` 编码 + Renderer 正则解码绕开这个限制，绕开
  就拿不到 code。
- **例外**：查询型 handler（list／scan／search 等）若失败时 Renderer 仍需 fallback data 或
  结构化 metadata 才能渲染，可保留 `{ success: true, ... } | { success: false, error, ...default }`
  模式。判断标准是“失败时 Renderer 是否需要结构化数据继续渲染”；需要就用 `{success}`
  风格，否则新 handler 默认走 `throwIpcError`。
- 不把堆栈、凭证、内部绝对路径或敏感响应原样返回 Renderer（安全细节见
  [`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)）。

## 3. main 侧业务逻辑默认带测试

- main 是跨平台、跨进程边界的高风险层，新增或修改业务逻辑时默认同步补单测或回归测试；
  确实无法自动化时，在 PR 自测里写明原因和手工验证路径。
- IPC handler 的业务体（参数校验、`throwIpcError` 错误路径、maker-host／localDb／auth 等
  依赖交互）应抽成可注入依赖的纯 handler 或小函数，`ipcMain.handle` 只做 adapter，这样
  测试可用内存 harness 直接 invoke handler body，无需启动 Electron。
- 新增 handler 至少覆盖主路径与关键错误路径；修改已有 handler 时补上能复现本次风险的
  回归用例。

### 3.1 测试资源与分层

默认 `test:unit` 必须适合多个 worktree 同时运行。新增、生成或改写测试时遵守：

- 默认单测优先使用进程内依赖注入、内存 fake 和表驱动用例；同一模块的重复初始化应合并到
  文件级 fixture，不要为每个断言重复启动子进程、仓库、数据库或监听服务。
- 默认单测不得访问业务外网、真实云服务或开发者账号。需要验证 HTTP／WebSocket 协议时，
  优先直接调用 handler；确需真实 socket 时只绑定 loopback，使用 `listen(0)` 的系统分配
  端口，并在 `afterAll`／`finally` 中关闭。禁止固定端口。
- 临时文件必须放在 `os.tmpdir()` 下由 `mkdtemp` 创建的唯一目录并可靠清理；禁止复用仓库外
  的固定目录、用户配置目录或跨 worktree 共享文件。测试不得修改全局 Git 配置、系统代理或
  其它机器级状态。
- 默认单测中真实 Git 只保留一条代表性 smoke；覆盖 index、patch、hook、ref、worktree 等
  组合语义的完整用例命名为 `*.git-integration.test.ts`，由
  `pnpm test:git-integration` 显式执行。不得因 review 或补回归把完整真实 Git 链路重新放回
  默认层。
- SQLite migration、runtime asset、严格性能计时等已有专用 tier 的资源测试继续进入对应
  tier。新增资源类型若无法进程内隔离，必须先在 `scripts/test-workspaces.config.mjs` 声明
  专用 tier，并按实际共享资源增加跨 worktree 协调；不要在测试文件里自行发明全局锁。
- “合并测试”只合并重复 fixture 和等价输入矩阵，不合并语义不同的失败路径，也不以删除断言
  换速度。若单文件仍有大量真实 I/O，迁移 tier，而不是继续扩大 timeout。

`scripts/__tests__/test-workspaces.test.mjs` 是 tier 边界的可执行契约；调整测试命名、include
或 exclude 时必须同步更新并运行 `pnpm test:runner`。

## 4. 跨平台双端兼容（macOS / Windows）

任何功能都必须同时考虑 macOS / Windows，并在两端做到最优性能。

- **路径与目录**：一律走 `path.join` / `path.resolve` / `path.sep`，禁止硬编码 `/` 或 `\`；
  用户目录走 `app.getPath('userData' | 'home' | 'temp')`，不拼 `~` 或 `%APPDATA%`。
- **子进程 / 原生二进制**：按 `process.platform` + `process.arch` 分发与加载；spawn 注意
  Windows 的 `.cmd` / `.exe` 后缀与 `shell: true` 差异；不要假设 POSIX 信号在 Windows 子
  进程生效，需要兜底显式 kill；env 变量名在 Windows 大小写不敏感、在 mac 敏感。
- **文件系统差异**：Windows 大小写不敏感、路径长度上限、文件锁与删除语义不同；涉及
  rename / unlink / 文件监听 / SQLite 文件迁移的逻辑必须两端验证。
- **性能基线以较弱一端为准**，不能“Mac 上流畅就过”。I/O 密集与渲染密集的关键路径要给
  出 Windows 上的可接受指标，优先选跨平台原生最优方案而非纯 JS polyfill。
- **快捷键 / 菜单 / 系统集成**（托盘、通知、窗口控制、全屏、`cmd` vs `ctrl`）按平台规范
  分别实现，不要把 Mac 交互照搬到 Windows。
- 改动可能影响平台行为时，在回复／PR 中说明“已分别考虑 macOS / Windows 的 X / Y”，
  未实测的平台标注待验证。

## 5. UI 文案与 i18n

任何 UI 文案的新增／修改／删除都必须走多语言体系，禁止界面里硬编码裸文案，禁止只改
一种语言。本节管“文案怎么落地进 i18n”，文案的语气／措辞见 `DESIGN.md` 的 Voice & Content。

- 资源在 `renderer/i18n/locales/<locale>/common.json`，语言由 `shared/locale.ts` 的
  `SUPPORTED_LOCALES` 定义（当前 `zh-CN` / `en` / `ja` / `ko`），组件通过 `react-i18next` 的
  `t('<嵌套.key>')` 消费，单 namespace `common`。
- **新增**：复用已有嵌套分组选 key，组件用 `t('key')`，绝不写 `<div>保存</div>` 裸文案。
- **修改**：改某 key 文案时 4 种语言同步更新，不要只改中文留其它语言旧值。
- **删除**：删 UI 时把对应 key 从全部 locale 一起删掉，不留孤儿 key。
- **翻译准确性**：`fallbackLng = 'en'`，缺 key 会静默回退英文。4 种语言都必须补齐并给出
  **准确**翻译，不留空、占位或“待校对”；ja / ko 没把握时先查证再写。
- **术语一致性**：写任何术语前先查 `i18n/GLOSSARY.md`。同一个概念在不同界面译法不一致
  是用户直接可见的质量问题（引入术语表时实测：162 个英文短语存在多种中文译法，反向
  227 条）。表里已裁决的术语**必须照用**，拿不准或表里没有的先在
  `i18n/glossary.json` 加 `status: "proposed"` 条目，别自己临时造一个译法。

### 5.1 术语表与门禁

- **数据正本**：`i18n/glossary.json`；人读版 `i18n/GLOSSARY.md` 由
  `pnpm i18n:glossary-doc` 生成，**不要手改**。
- **两级状态**：`decided` 违反即阻断 CI；`proposed` 只告警，用于承载「已知不一致但
  尚未拍板」的术语——让清单可见可讨论，而不是靠脚本替产品做裁决。
- **三类规则**：禁用译法、保留英文术语的大小写形态、zh-CN 半角标点与三语省略号。
  标点规则的适用范围由现状数据定，不靠直觉——例如日文 UI 惯例本就用半角冒号，
  ja 不套用中文的全角规则。
- **存量**：`i18n/glossary-baseline.json` 冻结引入时的既有违规，**只减不增**；修好一条
  就从账上删一条，已修复却仍挂账会报错。新增违规一律阻断。
- **误报处理**：guard 已剥离 `{{插值}}`、URL、文件名，并把连字符视作词边界
  （`ssh-agent` 不会被判成产品 `Agent`）。仍需放行时用 `exempt`——完整路径精确匹配，
  或以 `.` 结尾的子树前缀；同形异义必须在 `note` 里写明理由。
- **门禁**：
  - `pnpm check:i18n` 校验 key 结构——缺 key、孤儿 key、跨 locale 类型冲突报错阻断；
    空值与“与默认语言完全相同”只发警告。
  - `pnpm check:i18n-glossary` 校验译文术语与标点，并检查 `GLOSSARY.md` 是否与术语表同步。
  - 两者互补：前者管「key 齐不齐」，后者管「词译得一不一致」，谁也替代不了谁。改
    i18n 后两个都要跑（CI 已强制）。
- **影子 catalog**：有几批不走 i18next 的手写四语 catalog，根脚本只扫 locale JSON、扫不到
  这些 `.ts`。它们由 vitest 直接 import 运行时对象覆盖，复用
  `scripts/shared/glossary-rules.mjs` 的同一套判定，随 `test:unit` 阻断：
  - mobile：`src/auth/loginMessages.ts`、`src/session/newSessionMessages.ts`、
    `src/session/fullAccessConfirmationCopy.ts`（Full access 高风险权限提示）→
    `apps/mobile/src/__tests__/shadowCatalogGlossary.test.ts`
  - desktop：`src/main/applicationMenuLabels.ts`（macOS 原生菜单栏）→
    `apps/desktop/src/main/__tests__/applicationMenuLabels.test.ts`
  - desktop：`src/main/endpointManifestDialogCopy.ts`（启动期端点清单获取失败的系统弹框，
    弹在 createWindow 之前、renderer 与 i18next 都还不存在）→
    `apps/desktop/src/main/__tests__/endpointManifestDialogCopyGlossary.test.ts`
  - desktop：`src/main/oauthResultPage.ts`（OAuth 回调结果页，渲染在系统浏览器里）→
    `apps/desktop/src/main/__tests__/oauthResultPageGlossary.test.ts`。它的文案分散在
    若干函数里且要传 provider / brand 实参，测试用固定占位实参求值后再扫；占位值不含
    CJK 与标点，免得实参本身影响判定。

  新增同类手写 catalog 时记得加进对应测试的 `collectEntries()`。**catalog 要单独成模块**：
  原先这两份分别嵌在 `bootstrap-electron.ts` 与 `fullAccessConfirmation.ts` 里，测试一 import
  就会拉起整个 Electron 主进程 / react-native，根本跑不起来——这也是它们长期是盲区的原因。
- **Slack / IM 侧的文案不在任何 locale 文件里**：`src/main/hook-control/interactions.ts` 的
  权限卡片按钮是硬编码中文，与应用内 `permissions.alwaysAllowForSession` 是同一个动作。
  改产品术语时这类「同一动作、两处独立文案」要一起找出来，否则用户在 Slack 和 App 里
  看到两种说法。
- **批量改术语时必须跑全量 `pnpm test:unit`**：仓库里有若干测试直接断言中文文案
  （`automationGeneratedSessions.test.ts`、`builtinToolsCollabDescriptionI18n.test.ts`、
  mobile 的 `sessionMenu.test.ts` 等）。它们是有意的文案锁，改词后要同步更新期望值，
  不能靠 guard 绿灯就认为改完了。反过来这也是一层兜底——Session→对话 那轮正是
  `mobileCindyVoiceSession.test.ts` 暴露了漏网的「语音识别会话」（ASR WebSocket
  连接，不是产品对话）。
- **有些 locale 文案是 package 源的镜像**：改 locale 时必须同步改源，否则镜像断言会红。
  已知两处：`packages/maker-shared/src/sessionOperation.ts` 的 `DESKTOP_SESSION_CHAT_PLACEHOLDER_ZH_CN`
  （mobile composer placeholder 必须等于 desktop `ccAgent.layout.chatPlaceholder`）、
  `packages/maker-scheduler/src/builtin-templates.ts`（desktop locale 的 scheduler 模板块要求与
  package 源逐字一致）。这类断言不是碍事，正是它们保证了跨端文案不漂移。
- **标点可能不在 locale 里**：部分错误消息由代码拼接（如 `cloudVoiceHttpErrorMessage()`
  给 `composer.voice.refineFailed` 补半角冒号），guard 只扫 locale JSON，改不到也管不到。
  批量改标点后若测试断言与实际值方向相反，先查该文案的冒号究竟来自 locale 还是代码，
  别顺手把断言改成"看起来一致"的那个。
- **术语表是参考，不是替换表**：它回答「这个词该不该用」，不回答「该换成哪个」。
  表里的译法是默认情况下的选择，不是「见到 A 就换成 B」的映射——目标译法取决于该
  key 的英文源与实际用途，而脚本看不见语境。因此**禁止用 sed / 正则拿术语表做批量
  替换**，逐条交给 AI 按语境判断。这不是效率取舍，是正确性要求。

  门禁的输出也按这个定位设计：命中禁用译法时只报告事实并附上**英文源原文**，
  刻意不给替换目标（以前输出「应为 X」，读起来就是一条替换指令，于是很自然地被拿去
  做机械替换）。大小写与标点两类例外——`worker`→`Worker`、`,`→`，` 的答案与语境无关、
  唯一确定，那两处仍直接给目标。

  实测代价：#389 那轮批量替换引入的用户可见误译，经七轮 review 才收敛，约 35 处。
  典型如「额度」同时是 Balance / Quota / Credits 三个英文源的正确译法，「代理」同时是
  Agent / Subagent / Proxy 的译法——无条件替换必然改错其中两类。更隐蔽的是外部产品的
  既定术语被产品术语盖掉：macOS 系统设置面板名日文是「オートメーション」而非产品的
  「自動化」，照改会让用户按提示在系统设置里找不到授权项，授权恢复路径直接断掉。

  正确做法：guard 报出违规清单后，**逐条读英文源与该 key 的实际用途再决定**（这正是
  AI 擅长、脚本做不到的部分）。同形异义写进 `exempt` 并在 `note` 里说明理由；若某个
  禁用词对应多个英文源，用条件禁用 `{ text, whenEn }` 按英文源拆开，让每条规则的目标
  译法唯一——目标不唯一的禁用词就是误译的温床。改完仍需人工过一遍 diff。

  已登记的几组同形异义：ssh-agent ≠ 产品 Agent；Computer Use 的「自动操作」≠ scheduler
  的「自动化」；SSO 的「身份提供方」≠「模型供应商」；登录态 / WebSocket / SDK 运行时的
  session ≠ 产品「对话」；OS 的「活动桌面」≠ 产品的「活跃」；Jira 的「課題」≠ 产品 Issue。

## 6. 注释

- 所有类／对象都需要有明确的注释说明其职责；核心类的实现内部要有注释描述逻辑。
- 注释写"代码本身表达不了的约束与原因"，不复述下一行代码在做什么。

## 7. 渲染性能与视觉连续性

界面切换与动画的性能约束。动效的视觉规范（允许哪些过渡、时长、容器形变）见
[`DESIGN.md`](../design-rules/DESIGN.md) §14.4；本节只管性能红线与加载时序。

- **杜绝跳变与空白帧**：所有界面／子界面／边栏切换，过程中不产生让人难受的视觉跳变。
- **取数时序**：Render 层先异步获取数据（绝不能卡主线程渲染），获取期间界面不发生
  变化，拿到数据后再刷新显示。应用内数据大部分来自本地，默认**不做 loading 态界面**；
  需要不同设计时先和用户确认。
- **常驻动画必须 compositor-only（编码与 review 必查）**：常驻／循环的单元素简单动效
  （spinner、呼吸、shimmer 等）只允许写成 **HTML 元素**上的 `transform` / `opacity`；
  其它写法（`mask` / `background-position` 等，以及任何挂在 SVG 上的动画——SVG 上连
  `transform` / `opacity` 也不行）都会每帧惊动主线程，造成持续 CPU／能耗泄漏。图标
  动效一律挂外层 wrapper：
  `❌ <Loader2 className="animate-spin" />`；
  `✅ <span className="animate-spin inline-flex"><Loader2 /></span>`。
- **复杂动效**：多元素组合动效（错峰、内部形变等）不死限实现宿主（含 SVG），按表现力
  灵活选，但遵守性能原则：常驻 infinite 动画越少越好、能不错峰就不错峰、能限挂载时长
  就限。
- 动画只在有状态含义时挂载（如仅 running），响应 `prefers-reduced-motion`；性能有疑虑
  时用 DevTools Performance 实测，以数据为准。弹窗按钮 loading 等秒级瞬态存量不强制
  改，新代码一律照此。

## Review 清单

1. 有没有裸 `console.log`？临时排查日志是否清理干净？
2. 新／改 IPC handler 是否用 `throwIpcError` + `IpcErrorCode`？是否误用 `as` 强转或手写
   正则解码？`{success}` 风格是否只用在确实需要 fallback data 的查询型 handler？
3. main 侧新／改业务逻辑是否带了主路径 + 关键错误路径的测试？handler 业务体是否可注入
   依赖、便于免 Electron 测试？
4. 新增测试是否避免外网、固定端口、共享临时路径和重复真实子进程？资源测试是否进入正确
   tier，并保留了低成本默认 smoke？
5. 路径、子进程、FS、性能、快捷键是否在 macOS / Windows 两端都成立？未实测平台是否
   标注？
6. UI 文案是否全部走 `t()`、4 种语言齐全且翻译准确、无孤儿 key？术语是否照 `i18n/GLOSSARY.md`
   写、没有自造译法？是否跑过 `pnpm check:i18n` 与 `pnpm check:i18n-glossary`？
7. 新增类／核心逻辑是否有职责注释？
8. 新增常驻动画是否 compositor-only（HTML 元素 + `transform`/`opacity` + wrapper）、
   响应 `prefers-reduced-motion`？界面切换是否无跳变／空白帧、未引入不必要的 loading 态？

验证按 [`desktop-development.md`](desktop-development.md) 的分层选择：改 TypeScript 至少跑相关
类型检查与定向测试；改 i18n 跑 `pnpm check:i18n` 与 `pnpm check:i18n-glossary`；跨模块或
高风险改动再扩大验证范围。
