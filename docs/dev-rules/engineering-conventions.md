# 通用工程规范（Desktop / 客户端）

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、
> 客户端本地或远程数据读取／扫描、变化通知后的刷新、界面频繁触发的持久化写入、缓存与
> 轮询性能、跨平台（macOS／Windows）相关行为、任何 UI 文案的 i18n 落地，新增／修改动画与界面加载时序等渲染性能
> 相关行为，或新增一处每个功能都要来登记的列表、台账、注册表、版本号之前

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

### 3.2 新增测试的价值门槛

测试数量不是覆盖质量。后续 Agent 新增或改写测试时，每个测试文件在 PR 描述或邻近注释中都
要能回答「它保护哪个真实行为、历史 bug 或稳定契约」。没有可观察行为变化的重构、文档和
纯类型调整，不为了凑覆盖率新增测试。

- **测生产行为**：优先调用被测模块的公开函数、handler 或真实组件入口，断言用户可观察的
  结果、错误语义、权限边界、数据持久化或协议结构。禁止复制生产函数、常量表、JSX 或
  Tailwind 字符串后再与副本比较；只证明“源码里出现了某段字面量”的测试不算行为覆盖。
- **回归测试先红后绿**：修 bug 时先用最小用例复现修复前的失败，再验证修复后的通过。若
  只能测试静态契约，必须写出规则编号和保留原因，并把它放进明确的 guard／静态检查位置，
  不要把普通布局、类名、import 或调用顺序扫描伪装成 unit test。只包含跨文件静态契约的
  Desktop / Mobile 测试文件必须加入 `scripts/test-workspaces.config.mjs` 的 guard allowlist，并由
  CI 的 `pnpm test:guard` 执行；混合文件中的静态断言只有在保护权限、凭证、协议或竞态
  规则且无法从生产入口隔离时才保留，并在测试名或注释中写明失效后果。没有对应规则或
  失效后果的源码字面量断言直接删除。
- **控制文件数量**：同一领域的输入矩阵优先加入现有测试文件并使用表驱动；只有测试环境、
  生命周期、隔离资源或 tier 不同，才新建文件。一个文件只放一两个机械断言，或把同一行为
  拆成多个重复文件，必须合并或说明为什么不能合并。
- **不重复断言**：每条用例都应区分一个实际行为分支。只断言内部函数被调用，却不验证
  由此产生的用户可观察结果、错误语义、持久化或时序，通常没有独立价值；常量等于字面量、
  某个 class／属性存在、或重复同一 happy path 的用例应删除。调用、字面量或属性本身若是
  对外协议，可以保留，但要在测试名和注释中写明协议及失效后果。
- **隔离和分层**：默认 unit 使用进程内依赖注入、内存 fake；真实网络、外部进程、真实 Git
  矩阵、SQLite migration 和严格计时进入已有专用 tier。不要为了让 unit 变绿而把真实资源
  粗暴 mock 掉，也不要在测试里新增全局锁。
- **先查已有覆盖**：新增前先搜索相邻测试和相关入口；如果已有用例覆盖同一行为，只补缺失
  的输入或回归条件，不复制一套断言。删除候选测试时要确认剩余测试仍经生产入口覆盖该风险。

Agent 在提交新增测试前必须在 PR 描述或测试文件邻近注释中填清四项：被测生产入口和
用户可观察结果、对应的历史 bug／规则编号、现有覆盖为什么不够、以及最小失败输入和
所属 tier。四项有一项答不出来就不新增测试；修复后仍要保留能在回归前失败的最小断言，
不要用更多 happy path 来替代。

建议直接复制下面的模板填写；同一 PR 有多个测试文件时逐文件填写，不能用一句“补充覆盖”
代替：

~~~text
测试价值
- 生产入口与可观察结果：<调用哪个公开函数／handler／组件入口；用户或协议会看到什么>
- Bug／规则依据：<issue、回归提交或规则章节；没有就不新增>
- 现有覆盖缺口：<为什么相邻测试没有覆盖这个分支>
- 最小失败输入：<触发旧错误的最小输入、状态或时序>
- tier：<unit / guard / db / integration / e2e；为什么放这里>
- 实测耗时：<单独运行该文件的墙钟，例如 pnpm --dir apps/desktop exec vitest run <文件>>
~~~

用例的停止条件是覆盖完不同的结果分支：同一入口、同一结果只保留一个最小代表，更多
输入用表驱动表达；当新增用例不能指出新的结果、错误、权限、持久化、协议或时序差异时
就停止。不要设置“每个函数都要一个测试”或“覆盖率必须再涨一点”的数量目标，也不要
为了填满文件、提高测试条数或证明测试框架本身而新增用例。

评审可以直接要求删掉无法指出生产行为或契约的测试；“测试通过”本身不能证明它有价值。

#### 性能预算（与价值门槛同等强制）

单测的成本主要不在用例条数，而在每个文件的准备、收集（导入模块）和环境初始化。2026-10-16
实测 Desktop 每个分片的 worker 时间里，收集阶段与执行测试相当；一个逐用例重置模块的文件
（`codexProxyHost.test.ts`）就占全部文件耗时的约 10%，不重置时同样 285 条用例从 105 秒降到
7 秒。新增或改写测试时：

- **单文件预算**：新增或改写的单测文件单独运行应在 5 秒内（本机），超过 10 秒必须在 PR
  写明原因，并优先改用文件级 fixture、依赖注入或迁移 tier；不得用放宽 timeout 掩盖。
  「测试价值」模板里填写实测耗时。
- **模块只加载一次**：默认在文件顶部静态 import 被测模块。需要干净的模块级状态时，调用
  生产代码已有的 dispose／reset 或注入依赖；`vi.resetModules()` 只用于确实在验证「重启／
  重新加载」语义的边界，上一行写 `// reset-modules: <被隔离的状态>`，禁止放进
  `beforeEach` 或每个用例都会调用的 helper。
- **不做真实等待**：不用 ≥100ms 的 `setTimeout`／`sleep` 等异步结果，改用
  `vi.useFakeTimers()`、`vi.waitFor`／事件，或直接 await 被测 Promise。确需真实等待时上一行写
  `// real-wait: <原因>`。
- **环境按需**：只有真正渲染组件或操作 DOM 的文件才声明 `@vitest-environment jsdom`，纯逻辑
  留在 node 环境；jsdom 每个文件约多 0.5 秒初始化。
- **不新开小文件**：同一被测模块的新用例加进已有文件并用表驱动；每个新文件都要多付一次
  准备、收集和环境初始化。不超过 3 条用例的新文件必须说明为什么不能并入。
- **重 I/O 下沉**：真实子进程、真实 socket、真实 Git 或大量文件 I/O 让单文件超预算时，迁移到
  §3.1 的专用 tier，不要留在默认 unit。

**机器门禁**：CI verify 运行 `pnpm check:test-hygiene`（`scripts/check-test-hygiene.mjs`）并阻断
三类问题：没有写理由的 `vi.resetModules()`、没有写理由的 ≥100ms 真实等待、普通单测读取生产源码
文本（这类静态契约只能进 guard tier，不接受理由豁免）。存量计数记在
`scripts/test-hygiene-baseline.json`，只允许减少；修掉存量后运行
`node scripts/check-test-hygiene.mjs --update` 收紧基线。门禁从 GitHub PR／合并队列／push 事件
取得基准提交，本地使用 `origin/main`；逐文件、逐规则拒绝基线上调，手改 JSON 也不能放行。
只有确认基准提交确实没有基线文件时才允许首次登记；基准缺失、读取失败或基线格式错误均失败。
若当前分支已有高于 Git 基准的旧基线，先修复对应源码违规再运行 `--update`；更新器对新生成的
基线同时核对本地与 Git 基准上限，允许收紧修复，不允许把仍存在的新违规登记为存量。

### 3.3 路径断言的跨平台宪法

测试必须先区分路径代表的语义，不能把当前开发机的路径表示误当成跨平台事实：

- **宿主文件系统路径**：传给或来自 Node `fs`、Electron、子进程 `cwd` 等本机 API 的路径，
  期望值必须用 `path.join`／`path.resolve`／`path.relative` 构造；按被测语义使用
  `path.normalize`，涉及软链、junction 或物理文件身份时使用 `realpath` 后比较。禁止在这类
  断言中把 `/` 或 `\` 写成固定期望，也禁止只为让断言通过而把整段输出统一
  `replace(/\\/g, '/')`——整段替换会掩盖产品代码返回了错误路径格式，并可能误改 URL、转义
  内容或其它非路径文本。
- **逻辑路径**：URL／URI、远程 POSIX 路径、归档条目、wire protocol，以及契约明确规定用
  `/` 的 repo-relative 路径，不跟随宿主分隔符。这类测试可以固定写 `/`，但测试名称、类型或
  邻近注释必须明确它是稳定协议格式，不能仅凭字符串“看起来像路径”就归入例外。
- **模拟目标平台**：验证 Windows／POSIX 路径算法时使用 `path.win32`／`path.posix`，或把目标
  platform／path API 注入被测函数；禁止只 mock `process.platform` 后继续调用由宿主系统决定的
  默认 `path` 实现。Windows 大小写折叠也只在被测契约明确需要时进行，不能作为所有路径断言的
  通用归一化。
- **平台能力差异**：symlink、junction、文件权限等能力先做 capability probe。宿主确实不支持
  时可以跳过真实文件系统用例，但核心语义必须在支持该能力的受控 CI 平台继续实跑，或通过
  依赖注入／纯函数用例保留等价覆盖；禁止按 `process.platform` 大面积跳过后让整个 CI 矩阵
  失去相应回归保护。

PR 门禁必须在 Windows 上用多个并行分片（当前为 8 个）完整覆盖 `pnpm test:unit`；所有分片的
并集必须等价于未分片的全量测试，且由稳定的汇总检查统一阻断。分片数可以按 CI 实测耗时调整，
但分片矩阵必须连续列出 1..N 并与 `XDT_UNIT_TEST_SHARD` 的 N 一致。Desktop 按已提交的逐文件耗时
切分，各片必须读同一份数据（见 `desktop-unit-test-performance.md`）；只需执行一次的检查放在
独立并行 job，不叠加在某个分片上。`scripts/__tests__/dev-docs-contract.test.mjs` 锁住
该 CI 契约。不能用静态扫描“测试字符串是否含斜杠”代替 Windows 实跑，因为它无法可靠区分宿主
路径与逻辑路径。

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
  `SUPPORTED_LOCALES` 定义（当前 `zh-CN` / `zh-TW` / `en` / `ja` / `ko` / `es` / `fr` / `de` / `pt-PT` / `pt-BR` / `zh-Hant-x-lzh` / `zh-Hans-x-lzh`），组件通过 `react-i18next` 的
  `t('<嵌套.key>')` 消费，单 namespace `common`。
- **加载方式**：只有英文静态打包，其他语言由 `renderer/i18n/index.ts` 的 `LOCALE_LOADERS` 按需
  加载（新增语言要在这里加一行）；renderer 分发入口 `index.tsx` 先等 `i18nReady` 再加载各窗口，
  首屏直接是目标语言。`t(key, { lng })`、`getFixedT(lng)` 只对已加载的语言有效：需要在非当前
  语言下同步读文案的功能，把 key 加进 `scripts/i18n-cross-locale.mjs` 的 `CROSS_LOCALE_KEYS`，
  运行该脚本重新生成 `crossLocaleStrings.generated.json`，代码经 `@/i18n/crossLocale` 读取；
  改这些 key 的文案后同样要重新生成。测试需要其他语言时先
  `await i18n.loadLanguages([...])` 或 `await i18n.changeLanguage(lng)`。
- **新增**：复用已有嵌套分组选 key，组件用 `t('key')`，绝不写 `<div>保存</div>` 裸文案。
- **修改**：改某 key 文案时全部已支持语言同步更新，不要只改中文留其它语言旧值。
- **删除**：删 UI 时把对应 key 从全部 locale 一起删掉，不留孤儿 key。
- **文言版（繁 `zh-Hant-x-lzh`／简 `zh-Hans-x-lzh`）**：只能由用户手动选择，系统语言永不自动
  落到它；Intl 日期与数字按 `zh-Hant`／`zh-Hans` 格式化，缺 key 先回退 `zh-TW`／`zh-CN` 再回退
  英文。繁体版是译写正本，简体版由它转写生成（规则见 `i18n/classical-chinese-style.md`，含文风、
  术语表与必须保持白话的删除、权限、凭证、付款、安全文案）。选用文言界面时，每轮界面语言说明
  同时要求 AI 以文言作答，作答文风（唐诗、宋词等）在设置的语言卡片里选，登记在
  `packages/maker-shared/src/classicalReply.ts`；新增文风只需在该表加一项并补齐各语言的
  `settings.language.classical.styles.*` 文案。简体中文 / 繁體中文界面也有同一行文风选择：
  界面保持现代中文，默认「照常作答」，选中后才要求文言作答；文言界面与简体 / 繁體中文界面的
  文风分开记忆（classical / modern 两档，见 `classicalReplyStyleContextOf`），互不带值；
  style 名称统一叫「雅正文言」。IM 渠道不套用文言作答风格。
- **翻译准确性**：`fallbackLng = 'en'`，缺 key 会静默回退英文。全部已支持语言都必须补齐并给出
  **准确**翻译，不留空、占位或“待校对”；ja / ko 没把握时先查证再写。
- **术语一致性**：写任何术语前先查 `i18n/GLOSSARY.md`。同一个概念在不同界面译法不一致
  是用户直接可见的质量问题（引入术语表时实测：162 个英文短语存在多种中文译法，反向
  227 条）。表里已裁决的术语**必须照用**，拿不准或表里没有的先在
  `i18n/glossary.json` 加 `status: "proposed"` 条目，别自己临时造一个译法。
- **中文变体命名**：语言列表、选择器、设置项里的 zh-CN / zh-TW 一律按书写体系命名——中文界面
  「简体中文」「繁体中文」，英文界面「Simplified Chinese」「Traditional Chinese」。不要直接用
  `Intl.DisplayNames` 生成的「中文（中国）」「中文（台湾）」这类按地区的名称（2026-10-28 裁决：
  按地区表述在中国大陆有政治风险）；用 DisplayNames 生成名称时对中文变体做显式覆盖。

### 5.1 术语表与门禁

- **数据正本**：`i18n/glossary.json`；人读版 `i18n/GLOSSARY.md` 由
  `pnpm i18n:glossary-doc` 生成，**不要手改**。
- **条目顺序**：`terms` 按 `id` 升序，门禁校验。新术语插到按 id 排序的位置，不加在数组
  开头或末尾——都往同一处加时，任意两个加术语的 PR 必然冲突（2026-11-11 有 7 个未合并 PR
  卡在数组开头）。顺序不参与规则判定：扫描逐条独立，人读版生成时自行重排（已裁决在前，
  各组内按 id）。
- **两级状态**：`decided` 违反即阻断 CI；`proposed` 只告警，用于承载「已知不一致但
  尚未拍板」的术语——让清单可见可讨论，而不是靠脚本替产品做裁决。
- **四类规则**：禁用译法、保留英文术语的大小写形态、zh-CN 半角标点与三语省略号，
  以及只查 en 的写法规则（DESIGN.md §11.1 / §11.2：不写 Please、不用 successfully、
  正文不用直引号、按钮不用无宾的 Confirm / OK / Submit）。
  标点规则的适用范围由现状数据定，不靠直觉——例如日文 UI 惯例本就用半角冒号，
  ja 不套用中文的全角规则。
- **存量**：`i18n/glossary-baseline.json` 冻结引入时的既有违规，**只减不增**；修好一条
  就从账上删一条，已修复却仍挂账会报错。新增违规一律阻断。
- **误报处理**：guard 已剥离 `{{插值}}`、URL、文件名，并把连字符视作词边界
  （`ssh-agent` 不会被判成产品 `Agent`）。仍需放行时用 `exempt`——完整路径精确匹配，
  或以 `.` 结尾的子树前缀；同形异义必须在 `note` 里写明理由。英文写法规则另用
  `englishCopyExempt`：按规则名分组、只收精确 key，唯一用途是必须原样展示的格式字面量
  （JSON 示例、非法字符清单、终端命令）；文案不再命中时报豁免失效。
- **门禁**：
  - `pnpm check:i18n` 校验 key 结构——缺 key、孤儿 key、跨 locale 类型冲突报错阻断；
    空值与“与默认语言完全相同”只发警告。跨语言常驻表 `crossLocaleStrings.generated.json`
    与各 locale 不一致时同样阻断，按提示运行 `node scripts/i18n-cross-locale.mjs` 重新生成。
  - `pnpm check:i18n-glossary` 校验译文术语、标点与英文写法，并检查 `GLOSSARY.md` 是否与术语表同步。
  - 两者互补：前者管「key 齐不齐」，后者管「词译得一不一致」，谁也替代不了谁。改
    i18n 后两个都要跑（CI 已强制）。
- **影子 catalog**：有几批不走 i18next 的手写多语 catalog，根脚本只扫 locale JSON、扫不到
  这些 `.ts`。它们由 vitest 直接 import 运行时对象覆盖，复用
  `scripts/shared/glossary-rules.mjs` 的同一套判定（含英文写法规则，各自的既有问题按命中次数与文案摘要
  冻结在测试内的清单里、只减不增），随 `test:unit` 阻断：
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
- **IM 控制文案同样走 locale**（2026-11-12 起）：个人 bot（飞书、Telegram、Discord、微信、企业微信、
  钉钉、iMessage）、官方 hook（Slack／Telegram／X）和 `packages/lizi-im` 传输层发给 IM 用户的命令回执、
  状态、卡片按钮与错误说明，放在 `imBot.text.<渠道>.*`，经 `src/main/im/shared/imText.ts` 按主人的
  Cindy 界面语言现取；lizi-im 经 `setTransportTextResolver` 注入，缺 key 时回退包内中文。Agent 正文
  仍随来信语言，发给模型的上下文不走这里。新增 IM 文案时 12 种语言一起补，测试里断言中文的用
  `setMainLocale('zh-CN')` 固定语言。Slack 权限卡片按钮与应用内 `permissions.alwaysAllowForSession`
  是同一个动作，改产品术语时这类「同一动作、两处文案」要一起改，否则用户在 Slack 和 App 里看到
  两种说法。
- **批量改术语时覆盖相关文案断言，完整单测由 CI 兜底**：仓库里有若干测试直接断言中文文案
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

## 8. 客户端数据读取与扫描性能

本节约束 Main／Renderer 在用户可见路径上的数据读取、扫描、缓存、轮询，以及收到变化通知后的
刷新。数据在本机或另一台电脑上都适用：Desktop 查看端读取远程电脑的数据时，组件怎么读、怎么
共用、何时停止也按本节；同时沿调用链按 [`server-channel-review.md`](server-channel-review.md)
核对累计请求、回包体积，以及对共用连接上其他业务的影响。插件市场、实例查找、使用统计和
远程插件状态的专用边界见
[`plugin-security-and-authoring.md`](plugin-security-and-authoring.md) §5.4；
渲染动画与加载时序见 §7。Mobile 不在本节范围，但它读取执行电脑数据时同样按
`server-channel-review.md` 审查，做法可参照本节。本节只约束新增和正在修改的代码，不要求
专项重构存量。

### 8.1 一次用户动作只取一次快照

- 一次打开页面、一轮刷新或一次搜索是一个动作；同一动作内后续分页、来源切换和计数
  投影复用同一份安装快照。一次分页请求不得单独触发新的全量安装扫描。
- 安装、卸载、批准、切换账号或 owner／revision 变化后必须失效重取；不得把旧快照继续
  用于新动作。远程目标断线或重连后，按受影响的那台电脑重新判断旧快照是否可信，丢弃旧
  连接代次的迟到结果；离线期间不立即重取。
- 多个组件要同一份数据时（例如每个远程输入框都要知道有没有插件待确认），在数据归属代次、
  目标电脑、查询范围和影响结果的版本条件都相同时共用一份读取，同一时间只发一个请求。
  写入后需要的新鲜读取和授权复核，不并入写入前已发出的请求。
- 读取范围与要回答的问题相当：常驻的提示、角标、状态只取判断所需的字段，不复用为整页
  设计、带图标字节或完整 manifest 的快照。对端还不支持轻量查询时可按能力协商回退旧接口，
  但仍要共用、合并读取。
- 精确实例键走 `findInstalledInstance` 等单实例入口。单实例入口返回空不等于实例不存在，
  也可能是注册表缓存还答不上来：这时最多回退一次 `list()`，再按同一实例键精确匹配，回退后
  仍找不到才判不存在；不得借回退改按名字搜索或换成同名的其他副本（#9936）。「最多一次」
  按每次查找计；同一流程里后续的精确复核遵守同一约定，不能有的回退、有的直接判不存在；
  异步路径里的回退优先用异步扫描。
- 禁止在循环里调用带默认全量参数的查找函数，或逐条调用 `findAvailableGhost`。
- 验收：翻 10 页断言 `GhostManager.list()` 1 次；100 条记录循环断言 `list()` 1 次；
  精确实例查找在缓存命中时 `list()` 0 次、缓存答不上来时最多 1 次；同一共享范围内两个
  组件同时挂载，同一查询只读 1 次（能力发现与状态读取分别计数）。

### 8.2 读路径和轮询路径禁止写，界面触发的写入要有界

- 禁止在 `summary`、`get`、`list`、轮询、可见性恢复等读路径里执行持久化写（`bind`、
  migration、UPDATE、INSERT）或全量重建持久状态。
- 绑定和迁移只在安装、启动、首次使用或身份 revision 变化时执行；首次打开详情或首次工具
  调用的幂等 ensure 允许一次，后续轮询不得重复写。
- 不能凭 `get`／`list`／`summary` 这类名字断定接口只读：部分既有读取会初始化、迁移或对账
  （见 `packages/device-link/src/invokePolicy.ts` 的重试白名单注释）。要缓存、合并或重试
  一个读取前，先沿实现确认；已登记的首次 ensure 写清入口和边界。
- 界面会频繁触发的持久化写入（例如页面边操作边保存状态）：只有整份替换语义才合并，通常
  保持一个在途写入加一个最新待写值，未完成的请求有上限；持久化提交后才回复成功，超时或
  结果不明时不无条件重放；写入依赖先读到的旧值时，读取失败或账号、对象代次不确定就不开放
  写入，免得覆盖没读到的数据。页面卸载后，宿主已接受的写入可以提交完成，但不再更新界面、
  不发新的读取。逐条处理的消息和操作回执不按可合并处理。合并只发生在执行端时，从另一台
  电脑发起的每次保存仍是一次远程调用：要在 PR 写明每次保存触发几次远程调用，按键级的频繁
  保存要在发起端防抖或合并。多端可能
  同时写同一对象时，要么做版本校验，要么在协议记录里写明后写覆盖。参考 #9989 的页面状态，
  具体数值见协议记录，不是统一标准。
- 验收：连续调用 summary 3 次断言写事务 0 次；revision 不变时断言不再写；切账号后旧
  handle 不复活；在途写入期间连续保存多次，提交次数不随保存次数增长，最后一次值落库；
  读取失败时不开放写入。

### 8.3 隐藏、离屏、卸载后停止读取和轮询

- 组件不可见时不得发首页请求或继续轮询；`setInterval` 必须判断 `visible`／
  `document.visibilityState`。窗口隐藏不能只看 `document.visibilityState`：关闭后台节流的
  窗口最小化或隐藏后它仍是 `visible`，要同时接主进程的窗口隐藏广播（见
  `apps/desktop/src/main/windowHiddenBroadcast.ts`）。挂着但看不见的组件（保持挂载的隐藏
  面板、未激活的页签、隐藏的窗口）按不可见处理，不算共享读取的使用者。进行中的操作回执
  轮询（§8.7）不受可见性限制，但操作结束或组件卸载后停止。
- 组件卸载时立即取消自己的订阅、监听和定时器；只属于它的在途读取取消或丢弃结果，不再
  更新已卸载的组件。宿主已接受的持久化写入可以提交完成（§8.2），但不能因卸载被重放。
  多个组件共用的读取由共享层管理，一个组件卸载不中断其他组件还在等的请求。
- 单个组件的挂载、初始化或离线判断，不能作废其他组件还在用的共享数据。连接状态还不知道
  （例如首帧还没拿到在线状态）不等于离线，不能据此清缓存或退订（#8928 审查中修复过）。
- 靠销毁来做到隐藏后不再请求时，产品需要保留的用户状态（草稿、页码、展开位置）必须能从
  持久化数据或最初的输入重建，重建的读取和传输成本也要算进去；销毁不能成为状态丢失的
  理由。交互页面的销毁条件与状态保存见
  [页面生命周期](../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/REFERENCE.md#等待取消与页面生命周期)
  （#9929、#9989）。
- 最后一个使用者离开后，共享层可以保留已取得的数据和失效监听，供切回来复用；保留期限要
  写在代码或 PR 里。保留期间不发新读取、不轮询，新通知只标记失效、不延长期限；到期释放
  监听和缓存，只允许这一个到期回收计时器。账号、权限或目标失效时立即作废，旧结果不得回填。
- 恢复可见或切回时，缓存仍有效、且期间的变化都能感知到就直接复用；已失效或无法确认仍
  有效（例如断线期间可能漏了通知）时，合并补读一次。
- 后台下载、任务执行等明确的后台工作有独立生命周期和停止条件，不借用 UI 轮询。
- 验收：隐藏渲染断言加载函数 0 调用；卸载后除到期回收和已接受写入的提交外，没有界面回调
  和新读取；保留期内切回不读，期间收到相关变化则切回后只补读 1 次；到期后监听已释放；
  销毁后重新挂载能恢复需要保留的状态。连接状态用真实来源，或模拟首帧未知、断线重连，
  不能在测试里固定成在线。

### 8.4 分页、并发、缓存必须有界且 key 完整

- 禁止无界 cursor 追页、按用户数据量无界 `Promise.all`、单槽缓存承接多账号／多供应商／
  多查询、无上限 Map／数组长期增长。
- 缓存按 owner／revision／query／scope（或 provider）隔离，数据来自远程时再按目标电脑
  隔离；可以写进 key，也可以由实例作用域或代次校验保证。缓存有 TTL 或显式失效；读取失败
  不能当作已同步，有效的空结果可以复用。批量请求有单次批数和总批数上限。
- 验收：多账号或多 provider 交替轮询断言各自命中；切账号断言不读旧缓存；1000 条输入
  断言并发不超过设定上限。

### 8.5 热路径禁止同步 I/O 和 `sendSync`

- 禁止在 IPC handler（包括 device-link 远程调用和交互页面消息的处理函数）、Renderer 列表行、
  聊天行渲染路径里新增 `fs.*Sync`、`getGhostManager().list()` 或 `ipcRenderer.sendSync`。
  §8.1 的单实例入口及其「缓存答不上来时回退一次 `list()`」不算违规，但异步路径优先用异步扫描。
- 允许启动窗口创建前的小型固定配置读取和一次性 CLI；窗口级首帧缓存只允许整个窗口加载
  一次，并由 `ghosts:changed` 推送刷新，不得每行组件重复调用。
- 验收：精确查找测试在缓存命中时断言 `list()` 0 次；列表渲染测试断言每行不再 `listSync`；改动文件
  grep 不到新增同步 I/O。

### 8.6 收到变化通知后的重读

本小节针对「某类状态变了，需要的话自己重读」这类失效通知；需要逐条处理的消息、操作回执和
权限决定不当作可合并的状态处理。

- 先按归属、目标电脑、类别和对象过滤，与自己无关的不读；通知不带对象时按整个类别失效，
  不能因为缺对象而漏刷新。
- 合并窗口内的连续通知合并成一次读取，窗口时长写在代码或 PR 里；请求进行中只记一笔待刷新，
  完成后再补读一次。持续
  通知也不能无限推迟刷新，最后一次变化必须读到。
- 读取失败不能变成没有上限的紧密重试：没有新通知或用户操作时不自己反复重读；已有明确
  退避和重试上限的路径按原契约。
- 收到通知不代表目标状态一定变了（例如插件变化通知也包括角标变化），重读要轻，按 §8.1
  只取所需字段。「轻」也包括对端：每次重读在对端要做多少扫描，多个控制端会各触发一次，
  能复用对端已有的结果就不要每次重算。
- 挂在每个任务、输入框或列表行上的常驻组件，按实际场景估算累计成本：同时挂载多少个、
  切换多频繁、通知多密集，算出请求次数和回包字节并写进 PR，注明是实测还是推导；不能只看
  单个组件读一次的开销。
- 验收要在有持续通知的场景下做，不能只验证功能流程：无关通知读取 0 次；同一合并窗口内的
  突发通知，读取次数不随通知数增长；间隔分布的持续通知期间并发最多 1 个，待刷新不随通知数增长；慢请求和
  读取失败期间不叠加、不自转；最终读到最后一次变化。
- 参考做法：远程输入框的插件待确认提示（#8745、#8928）只认插件类通知、走轻量查询、按电脑
  共用读取、短时间合并、在途不并发、失败不自转，最后一个输入框离开后保留缓存 30 秒。其中
  250ms、30 秒是该路径的取值，不是统一标准；它还没做到输入框看不见时停止订阅，新代码按
  §8.3 处理。

### 8.7 预算与例外

- 预算：单次市场分页 1 页服务器数据；单次安装扫描 1 次／浏览或刷新代次；磁盘扫描并发
  不超过现有实现的 4 路；批量 resolve 单批 ≤100 且总批数有上限，超限返回
  `counts: null`，不继续无界请求；统计类轮询默认 15 秒（分享申请等有时效要求的
  可保持 5 秒）；操作回执 1–1.2 秒且仅操作进行中；列表载荷只含展示所需字段，图标只带
  引用（地址、校验值等元数据），不嵌入图片字节或 base64，也不带完整 manifest。
- 预算是上述现有路径的基线，不是所有客户端读取的统一额度；改数字必须附测量证据；不得因
  存量代码未达标阻断无关改动。
- 例外必须可定位：小型固定配置、一次性 CLI、固定小数组并行、纯本地短计时器、明确的
  后台任务、首帧窗口缓存，以及 §8.3 所述卸载后有界保留的缓存、失效监听与到期回收计时器。
  例外要在代码或 PR 写清原因、边界和验证方式。

验收对照（文件只表示起点；未覆盖的断言在实现 PR 中补，不能把文件存在当作已验证）：

| 规则 | 测试／检查 |
| --- | --- |
| 8.1 一次快照 | `plugin-market/__tests__/service.test.ts`、`PluginCatalogBrowser.test.tsx`、`ghostWorkdirGate.test.ts`（缓存未就绪时回退一次） |
| 8.2 读路径不写、界面写入有界 | `plugin-usage/__tests__/ipc.test.ts`、`service.test.ts`、`mcp-apps/__tests__/viewState.test.ts` |
| 8.3 可见性与卸载后保留 | `PluginCatalogBrowser.test.tsx`、`PluginUsageCard.test.tsx`、`RemotePluginPage.test.tsx`、`McpAppCard.test.tsx`（离屏销毁）、`viewState.test.ts`（重建后恢复） |
| 8.4 缓存与并发 | `providerShareInsights.test.ts`、`providerShareInsightsFlow.test.tsx` |
| 8.5 同步 I/O | `useInstalledGhosts.test.tsx`、精确查找测试 |
| 8.6 变化通知 | `RemotePluginPage.test.tsx`（过滤、同一窗口的突发合并、切换复用）、`cindy-brain/__tests__/remotePluginManagement.test.ts`（轻量载荷、无授权副作用）；间隔分布的持续通知、慢请求下最终读到最后一次变化，现有测试未覆盖 |

## 9. 不制造共享追加点

合并冲突的主要成因不是文件大，而是许多 PR 改同一行，或都往同一个位置插入。两个 PR 各改
一个大文件的不同区域可以自动合并；各往同一处加一行则必然冲突。这类冲突没有语义分歧，
只是登记方式造成的，却要每个 PR 逐个处理，后合入的还要再做一遍。

2026-11-11 对最近 14 天更新过的 189 个冲突 PR 逐个与 `main` 模拟合并（当时未合并 PR 618 个，
368 个处于冲突）。下表是多数 PR 落在同一位置的文件；同期 `register.ts` 命中 29 个 PR，
除 import 区外分散在 58 处，属于正常的并发修改。

| 位置 | 命中的冲突 PR | 成因 | 现状 |
| --- | --- | --- | --- |
| `protocol-compatibility.md` | 31 | 新记录都插在文首 | 已拆成每项能力一个文件，并由 `pnpm check:dev-docs` 守护 |
| 大文件的 import 区 | `register.ts` 18、`mcp-providers.ts` 9、`bootstrap-electron.ts` 9 | 同一条 import 里各加一个名字，或都在末尾加一行 | 未治理 |
| `BUILT_IN_SKILLS_BUNDLE_VERSION` | 10 | 每个改内置 Skill 的 PR 都把同一个整数加一（近 30 天 94 次） | 已改成基数 + 记录文件数，每次改动新增一个记录文件，由 `pnpm check:built-in-skills` 守护 |
| `createLiziMcpProviders({ ... })` 的 `xdtHelper` | 8 | 每个新 helper 工具都往同一个 600 行的依赖对象里加属性 | 未治理 |
| `HELPER_CATEGORY_DESCRIPTIONS` | 7 | 一个类目的说明写成一整行，增删该类目工具都改这一行 | 已改成一句一行再拼接，拼出的文字不变；新增内容单独起一行 |
| `agent-user-parity.md`「现状台账」 | 7 | 每个 helper 工具改动都要写回同一张表，新行集中插在少数几处 | 未治理 |
| `i18n/glossary.json` | 7 | 新术语多插在 `terms` 数组开头 | 已按 id 排序，由 `pnpm check:i18n-glossary` 守护 |

新增一处每个功能都要来登记一笔的位置，或发现现有位置反复冲突时：

- **列表、台账、注册表**：一项一个文件，目录本身就是索引；必须放在同一个文件时，规定按键
  排序并由检查脚本守护。不规定「加在开头」或「加在末尾」。
- **计数器、版本号、合计**：从内容推导。必须人工维护时，不让两个 PR 写同一行。
- **一行里的多项内容**（数组常量、同一条 import 的多个名字、汇总多个工具的长描述）：拆成
  一项一行并排序。只拆行不够：两处新增都落在末尾仍然冲突，排序才让它们落在不同位置。
- **生成物**：只入库稳定的登记事实；随每次改动变化的统计数字按需生成。设计台账的统计列
  即按此移出入库文件（`pnpm design:inventory:report`）。

复查用 `pnpm repo:conflict-hotspots`（[`scripts/repo-conflict-hotspots.mjs`](../../scripts/repo-conflict-hotspots.mjs)，
需要 gh 已登录；不改工作区和分支，临时引用结束时删除）。读法：一个文件命中很多 PR 但位置
分散，是正常的并发修改；多数 PR 落在同一位置（报告标「共享追加点」）才需要从结构上消除。
治理一处后把上表对应行的现状写回来。

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
6. UI 文案是否全部走 `t()`、全部已支持语言齐全且翻译准确、无孤儿 key？术语是否照 `i18n/GLOSSARY.md`
   写、没有自造译法？是否跑过 `pnpm check:i18n` 与 `pnpm check:i18n-glossary`？
7. 新增类／核心逻辑是否有职责注释？
8. 新增常驻动画是否 compositor-only（HTML 元素 + `transform`/`opacity` + wrapper）、
   响应 `prefers-reduced-motion`？界面切换是否无跳变／空白帧、未引入不必要的 loading 态？
9. 是否新增了每个功能都要改同一行、或都往同一位置追加的登记点（列表开头／末尾、手动
   递增的版本号、单行数组）？是否改成一项一个文件、按键排序或从内容推导？
10. 本次改动每个用户动作和每次变化通知会触发几次 `list()`／扫描／IPC／写事务？读远程数据时，
    远程调用次数和回包字节是多少？隐藏／卸载后是否停止读取和轮询（§8.3 的有界保留和到期回收除外）？
11. 缓存是否按 owner／revision／query／provider 及目标电脑隔离，是否有 TTL／失效路径，旧代次的
    迟到结果会不会回填？挂在每个任务上的常驻组件是否共用读取？
12. 界面频繁触发的持久化写入是否合并、在途有上限、提交后才回复成功？读取失败时是否不开放
    写入？靠销毁停止请求的组件，重新挂载后能否接回需要保留的状态？

验证按 [`desktop-development.md`](desktop-development.md) 的分层选择：改 TypeScript 至少跑相关
类型检查与定向测试；改 i18n 跑 `pnpm check:i18n` 与 `pnpm check:i18n-glossary`；跨模块或
高风险改动再扩大验证范围。
