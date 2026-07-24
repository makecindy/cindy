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
- **门禁**：`pnpm check:i18n` 校验 key 一致性——缺 key、孤儿 key、跨 locale 类型冲突会
  报错阻断；空值与“与默认语言完全相同”只发警告。它保证 key 结构齐整，但**翻译是否
  准确仍需人核**，改完至少跑一次 `pnpm check:i18n`。

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
4. 路径、子进程、FS、性能、快捷键是否在 macOS / Windows 两端都成立？未实测平台是否
   标注？
5. UI 文案是否全部走 `t()`、4 种语言齐全且翻译准确、无孤儿 key？是否跑过 `pnpm check:i18n`？
6. 新增类／核心逻辑是否有职责注释？
7. 新增常驻动画是否 compositor-only（HTML 元素 + `transform`/`opacity` + wrapper）、
   响应 `prefers-reduced-motion`？界面切换是否无跳变／空白帧、未引入不必要的 loading 态？

验证按 [`desktop-development.md`](desktop-development.md) 的分层选择：改 TypeScript 至少跑相关
类型检查与定向测试；改 i18n 跑 `pnpm check:i18n`；跨模块或高风险改动再扩大验证范围。
