# Final：让 Mivo library 成为 Agent 能读的媒体库（Cindy 宿主侧决策）

> 状态：PR0 契约正本（与 `docs/dev-rules/plugin-library-storage.md` 不变量 11–12 对齐）。**行号锚点以 main@6e114a35（2026-08-31 与远端同步后）为准。**
> 输入：Sol 预检清单 + 三份 code-explorer + 源码逐行核对 + kirozeng 在 mivo-canvas-plugin#398 的评论（2026-08-31T14:01:17Z）+ 同步远端后全锚点复核。
> 范围裁决（owner 2026-08-31）：远程/SSH 不考虑；容量/压缩/进度条/30 天清理是后续；路径泄漏规避即可；授权必须自动、不弹卡。
> kiro 表态（已收）：红线 2 对 **library 已 confirmed** 的图放开像素直读；老路 cindy-media 保留备胎；Mivo 文档由他改。

## 0. 一句话结论

图只要进了 library 并且 **confirmed**，当前使用 Mivo 的那条任务里的 Agent（Claude / Codex / Pi 三个都要）就能用普通 Read 直接读像素，不再经过 cindy-media，且用户不需要点任何授权卡。主路径 = 宿主把 library 根静默写入该会话的只读 extraDirs；Claude 额外补一次「续聊式 Query 重建」。拷贝进工作目录不是最终答案。

Kiro 选 A 之后，原先最大的红线冲突（「进画布只读节点、选中才送像素」）已经解开。G2 不翻盘。

## 1. 核心决策（D1–D8）

### D1 主方案 = G2 目录授权直读
library 根作为会话级只读引用目录（extraDirs / readOnlyRoots）授权给当前任务。Agent 用原生 Read 读像素，节点/坐标仍走 Mivo 插件 MCP。
- 否决 H2（opaque handle 宿主代读）：三个 harness 都要新工具，路径泄漏没严重到值得换整条读图通道。
- 否决「拷贝进会话工作目录」作为架构：每张图变副本，library 仍是局外人；只允许作 Claude 重建落地前的临时缺口，PR 里写明删除条件。
- kiro 背书：今天 Agent 已经在用普通 Read 读 cindy-media blob 目录（Mivo `ghost.json:86`）。G2 只是把可读目录从 cindy-media 换成 library，不是新范式。

### D2 三个 Agent 全支持，不挑单一环境
- Codex：`setExtraDirs` 现成，下一 turn 生效（runtimeWorkspaceRoots 每 turn 现读，Sol VERIFIED）。**必须 app-server ≥ 0.144.6**；低版本 `setExtraDirs` 直接抛错（`codex/index.ts:12445-12449`，启动时 extraDirs 非空也会在 `4518` 炸掉）。PR-V 要闸版本，低版本走 cindy-media 备胎，不得假装授权成功。
- Pi：`setExtraDirs` → 权限文件热更新，当轮生效；READONLY_BUILTINS（read/grep/find/ls）非凭证路径直接放行不弹卡。「能读」这件事上最顺。
- Claude：`additionalDirectories` 在 Query 创建时冻结（`claude-code/index.ts:3543` 附近传入 sdkQuery），`setExtraDirs` 只改 closure（`6615`），普通 send() 不重建 → 中途授权对 SDK 无效。必须补 D3。能力表注释仍自称「下一 turn 立即生效, 真正的 hot-reload」（`862`），与冻结注释矛盾——PR-V 顺手改注释，不另开 PR。
- 只挑一个 agent = 用户换模型后画布图忽明忽暗，否决。

### D3 Claude 冻结的解法 = 续聊式 Query 重建
授权/撤销 library 根后，若当前 Query 的目录名单与最新 closure 不一致，在下一次 send 前走 rewind 同款「close 旧 q → buildQuery({resumeSessionAt, forkSession:true})」续上同一场对话。禁止用 `fresh:true`（那是另开一场）。
- 必测：SDK 在 resume 续聊时是否吃新 additionalDirectories；测不过退到从最新 checkpoint fork，仍是续聊。
- 撤权侧已有：`auto-review-policy.ts:248-255` 把 Read 标 `requireWorkspaceBoundary: true`；区外读在 `shared/auto-review.ts:118-123` 升 `prompt-each-time`（tree 级区外根另有 `prompt` 分支，`127-128`）。**宿主审核门现读**，撤权当轮即在宿主面生效，即使 SDK allowlist 还冻着旧根。保留不动。
- Pi 普通只读不经这条 adapter（bridge `READONLY_BUILTINS` 直放）；Pi 的「能读」靠 extraDirs 进权限文件，不靠 auto-review 升档。
- 会话恢复 / lazy-create 已从 SQLite extra_dirs 回灌 → 「先授权再开聊」三 harness 天然通，不需重建。

### D4 授权自动化：静默写入，不弹卡，不动权限档
- 事实核对（main@6e114a35，与远端同步后复核）：`applyDirectoryGrants` **存在**，是 `register.ts:16615` 的局部函数（`SET_EXTRA_DIRS` / `SET_WRITABLE_DIRS` 两个 handler 在 `16705`/`16716` 调它），不是导出 API；`consumeWritableDirectoryPickerGrants` **存在**（`writableDirectoryPickerGrant.ts:55`），只服务 **writableDirs** 轴。extraDirs 轴没有确认卡，main 侧校验只有 `validateExtraDirs`：绝对路径 / 存在 / 是目录 / 非工作区子目录 / 上限 10。kiro 说这两个名字「全仓不存在」在同步后的远端 HEAD 上依然不成立，**不采纳**。
- 所以：Mivo 会话打开且 library 可用时，宿主在 **main 进程内部**调用 `applyDirectoryGrants('extraDirs', …)` 注入 library realpath。合法、不需要新权限面、不弹卡。它今天只被 `SET_EXTRA_DIRS` IPC 包着——PR-V 要把这个局部函数抽成 main 可调的内部入口，供 library-ready / 迁根 / 卸载走，**不要再造一条平行授权通道**。
- 明确否决「切 bypassPermissions / Full Access」：那是全盘放开，与「只读这一块作品库」量级完全不同。授权后 Ask/Auto 档区内读自动放行，本来就不弹卡，无需 bypass。
- 边界：只授权给当前使用 Mivo 的会话；不授权可写；不广播到所有会话。
- UI 呈现：运行时静默，但设置里的「额外目录」列表应把它显示为「Mivo 作品库（只读）」系统项，与用户自选目录区分，且不占用户的 10 个名额（需要专用槽位或豁免计数）。
- 生命周期：library 迁移 / 插件卸载 / 换绑定必须同步改/撤该会话 extraDirs——extra_dirs 持久在 SQLite，不撤会钉死在旧路径。**迁根成功后旧根会被改名 `<old>.migrated-<ts>`（14 天 grace）**，extraDirs 不同步是立刻 ENOENT，不是「钉死旧路径还能读」。

### D5 路径泄漏 = 规避，不重构
- 插件 ghost_call 回执只用相对键 / 资源 id / 指纹，禁止出现 `/Users/.../libraries/<ghostId>/`（对齐 plugin-library-storage.md Review 清单第 1 条）。
- **握手字段同样禁绝对路径**：Mivo `recordLibraryProbe()` 会把 open/status 回执原文落到 `diagnostics/library-probe.json`，插件侧没有脱敏。绝对根只由宿主注入 extraDirs + 宿主提示词给 Agent；插件继续不知道绝对根。
- 已授权后插件回执的 available 引用改成相对键 `library:assets/<2>/<hash>/blob.<ext>`；未授权维持 `cindy-media://` + `deposit_media`。协议形状不动，只改值。
- Pi 的 `piExtraDirsPrompt`（`pi/index.ts:1134`）现在把绝对目录逐条写进每个后续 user turn，改成不含绝对路径的能力描述（如「本任务可只读引用插件作品库」）。
- Read 工具参数里出现真实路径不可避免，owner 已裁决可接受。落库 8KiB 截断维持现状。
- reveal_path 不得当库根授权用（它是一次性单文件确认卡）。
- **library 内路径不保证跨 turn 稳定**：Agent 每次从最新回执取相对键，不得缓存。归档接线后 `archive/` rename 会让热区失效。

### D6 「无限扩容」的诚实口径
本次只保证：摆脱 cindy-media 的 **1GiB 寄存配额** + 解锁 **SVG**（cindy-media 双重拒收 SVG）。cindy-media 单件上限是 **50MiB**（`GHOST_CINDY_DEPOSIT_MAX_BYTES`，2026-07-29 已从更低值上调），不是 16MiB。**16MiB 是 library 单次读写分块阈值**（更大走 writeBegin），两个数不能串。library 自身仍有 8GiB 软水位（仅告警）+ 磁盘保留 1GiB 硬拒 + 50,000 文件保险丝（libraryVault.ts DEFAULT_LIBRARY_LIMITS）。容量归用户，产品只提醒和兜底——进度条 / 压缩 / 30 天清理 / 快满拒写全部后续，不进本次 PR。

### D7 两步变一步的口径
- 对用户：成立。不再需要「选中 → 送进 cindy-media → Agent 才能看」。
- 对 Agent 内部：仍是两类工具（插件 MCP 给节点/坐标，Read 给像素），少掉的是 cindy-media 中转那一跳。
- **只对 confirmed 放开。** 判据只认宿主 `librarySlot.writeCommit` ACK 的 64-hex sha256（`library-write` / `writeCommit` 回执）。仓内无 `libraryConfirmed.ts`（不存在），不得发明该文件。`writing` / `unconfirmed` / `unavailable` 不放开。cindy-media 短指纹（16–128 位）不得升格。
- 未进 library 的图、以及未 confirmed 的图，Agent 仍读不到——这是设计而非缺陷。
- SVG：G2 的新增能力。直读原文字节，不再要求 cindy-media 加 `image/svg+xml`。定位必须经别名索引（节点是 `mivo-asset:<uuid>`，不含 hash）。**未授权时 SVG 没有 cindy-media 备胎**，维持读不到。

### D8 范围排除（本次不做）
远程/SSH extraDirs 透传；容量治理 UI；Mivo 插件侧接线（握手消费 / 回执形态 / 文档改口径由 kiro 在 PR3 字段定稿后做）；H2 代读通道；全局（跨会话）library 可读。

## 2. PR 拆分（Cindy 宿主仓，均未开工）

| PR | 内容 | 痛点 | 关键约束 |
|---|---|---|---|
| PR0 契约 | 写明「library 根可作会话级只读目录」：只进当前 Mivo 会话、只读、插件沙箱仍零文件、回执/握手禁绝对路径、只认 `blob.*`、路径不跨 turn 缓存、confirmed 才放开 | 现在没有这句话，三个 harness 对着空气接线 | 文档改动，GO |
| PR1 安全打开器 | libraryVault 读路径补 fileReadBytes.ts 同款 O_NOFOLLOW + bigint dev/ino 同 fd 复核 | 现 read() 无身份复核，直读把这条缝暴露给 Agent | 仅宿主内部用 |
| PR2A/2B 改图/上传切根 | editImage / upload 消费口从 cindy-media hash 改认 library 正本 `assets/<hash前2>/<hash>/blob.<ext>`（固定文件名 `blob`，不是 `<hash>.<ext>`，也不是已否决的 canvases/ 前缀）。sidecar `meta.json`/`preview.webp` **禁止当像素** | 画布正本在 library，再经媒体库是双份 | 用 Mivo `BAD_RECEIPT` 公式当契约测试，别只对文档 |
| PR3 插件可见握手 | **只挂 Library open/status 回执**（不选 app-context：它只消费 locale，3s 超时会让授权态未知成常态）。字段：「已授权只读作品库」布尔 + **库代次/身份**（迁根/bind/unbind 后失效本机 ACK）。谁问谁得（open/status 不带会话身份）。不回绝对路径 | Agent 不知道已授权，会继续往 cindy-media 送；换库后插件说 confirmed、当前根没文件 | 字段定稿前 Mivo 三道回执门禁不放宽 |
| PR-V（本次主 PR） | ①Mivo 会话 + library ready → 宿主经抽出的 `applyDirectoryGrants` 静默注入 library realpath（专用槽位，不占用户 10 名额）②Codex/Pi 走现成 setExtraDirs；Codex 闸 ≥0.144.6 ③Claude 目录代际不一致时续聊重建 ④Pi prompt 去绝对路径 ⑤迁移/卸载/bind-unbind 同步改撤 extraDirs ⑥临时拷贝兜底带删除条件 ⑦修正 CC 自相矛盾注释 | 图在 library 里 Agent 看不见，是整个目标的最后一公里 | fresh:true 禁用于授权；**必须等 PR3 握手字段落地**，否则 Agent/插件行为不确定 |

依赖：**PR0 → PR1 → {PR2A, PR2B} → PR3 → PR-V**。
PR-V 不再与 PR3 并行。没有握手，授权了 Agent 也不知道该走哪条引用形态。

切根会碰到的合法落点（PR0/PR2 契约必须列全）：`assets/<2>/<hash>/blob.<ext>` 正本；同目录 sidecar 禁止当像素；`attachments/<canvasId>.json`；`index/asset-aliases.json`（非内容寻址节点定位正本的唯一途径）；`families/`；`exports/`；`assets/_staging/`、`assets/_probe/`；契约预留但今天未接线的 `archive/`、`trash/`；`.cindy-library/` 宿主保留。

## 3. 验收门槛（不过 = 没做成）

1. Codex：app-server ≥ 0.144.6 时，会话中途注入 library 根，下一 turn Read library 内 confirmed 图成功；Ask/Auto 不弹卡；write 被拒。低版本不得假装授权成功，必须回 cindy-media 备胎。
2. Pi：中途注入当轮 read 成功；后续 prompt 无 `/Users/.../libraries/`；结构化写进 library 根被拦（含 Full Access）。
3. Claude：开聊即有根 → 首 turn 可读；中途授权 → 重建后下一 turn 可读且仍是同一场对话；fresh:true 路径未被用于授权。
4. 静默性：全程无授权卡弹出；权限档保持用户原档（Ask/Auto/Full 均可用）。
5. 迁移后旧根立刻失效（ENOENT）、新根生效；卸载后撤权；`library-bind` / `library-unbind` 后库代次变化，插件本机 ACK 失效。
6. 插件 MCP 回执与 open/status 握手 grep 不到绝对路径。
7. 无关会话读同一 library 文件 → 弹卡或拒绝。
8. 用户已有 10 个自选 extraDirs 时，library 槽位不挤占、不被挤掉。
9. 未 confirmed / writing / unavailable 的图不走直读；未授权时 cindy-media 老路仍可用；SVG 仅在已授权+confirmed+别名可解析时可读。

## 4. 已识别风险与反转条件

- R1 Claude SDK resume 续聊不吃新 additionalDirectories → 改用 checkpoint fork 续聊；仍不行才允许临时拷贝兜底，且不改回「拷贝为架构」。
- R2 validateExtraDirs 的 redundant-subdir / 上限 10 与自动注入互踩 → PR-V 内做专用槽位或豁免逻辑，不改用户可见语义。
- R3 Pi grep/find/ls 区外递归不经 host（已知行为差异）→ library 根本来就要授权成区内，非本次新增风险；记录不修。
- R4 产品未来要求跨会话全局可读 → 授权面从会话级变全局，另立方案，不在本次范围。
- R5 迁根后 extraDirs 不同步 → 立刻 ENOENT。PR-V 必须把 relocate 成功当作硬门槛同步改 extraDirs，验收第 5 条覆盖。
- R6 `library-bind` / `unbind` 不迁移内容 + 插件 ACK 留在 IDB → 「插件说 confirmed、当前根没文件」。靠 PR3 库代次让插件失效 ACK；宿主不同步授权则直读 ENOENT。
- R7 SVG 无 cindy-media 备胎 → 未授权/降级时 SVG 读不到是预期，不要当回归修。

## 5. kiro #398 反馈收口（本轮裁决）

| kiro 意见 | 裁决 | 理由 |
|---|---|---|
| 选 A：confirmed 图放开像素直读，老路保留 | **采纳，G2 不翻盘** | 最大红线冲突已解；未授权/旧宿主必须还能走 cindy-media |
| 握手挂 Library open/status，不选 app-context | **采纳，改 D4/PR3** | app-context 只消费 locale，3s 超时会让授权态未知成常态 |
| PR3 必须先于 PR-V | **采纳，改依赖** | 没有握手，Agent 不知道该读哪种引用 |
| 回执/握手禁绝对路径（含 probe 落盘） | **采纳，写入 D5/PR0** | `recordLibraryProbe` 原文落盘，不能靠插件脱敏 |
| 相对键 `library:assets/.../blob.<ext>` | **采纳** | 协议形状不动，只改值 |
| 切根只认 `blob.*`，公式不是 `<hash>.<ext>` | **采纳** | 定稿正文原先已写对；实现别按 cindy-media 类推 |
| 16MiB 不是 cindy-media 单件上限 | **采纳，改 D6** | 寄存单件 50MiB，配额 1GiB；16MiB 是 library 分块 |
| Codex 闸 ≥0.144.6 | **采纳，写入 D2/验收** | `setExtraDirs` 低版本抛错 |
| SVG 直读原文，关 #290 第 3 项 | **采纳进 D7**；关 issue 是 Mivo 侧 | 定位必须走别名；未授权无备胎 |
| 迁根改名旧根 + bind/unbind 代次 | **采纳，写入 D4/PR3/R5/R6** | 今天只表现为补图失败，G2 会放大成 Agent ENOENT |
| 路径不跨 turn 缓存 | **采纳，写入 D5/PR0** | 归档接线后会 rename |
| confirmed 复用 `libraryConfirmed.ts` | **驳回发明文件；采纳 writeCommit ACK** | 仓内无 `libraryConfirmed.ts`（不存在），不得发明。confirmed 只认 `librarySlot.writeCommit` ACK 的 64-hex sha256 |
| `applyDirectoryGrants` / picker 函数「全仓不存在」 | **驳回**（同步远端后复核仍在） | main@6e114a35：`register.ts:16615`、`writableDirectoryPickerGrant.ts:55` 都在；PR-V 抽局部函数给 main 调，不新写权限面 |
| D3 引用 `auto-review-policy.ts:248-255` 不存在、档位是 `prompt` | **驳回行号/档位；部分采纳 Pi 差异** | CC 侧该文件 406 行，248-255 恰是 `requireWorkspaceBoundary: true` 那段；区外读升 `prompt-each-time`（shared/auto-review.ts:118-123）。kiro 说的 155 行文件是 **pi/auto-review-policy.ts**（现 164 行）——他对错了文件；Pi 普通读不经 adapter 这条采纳 |
| CC 冻结行号 3355 / setExtraDirs 6415 / Pi prompt 963 | **驳回** | main@6e114a35 是 3543 / 6615 / 1134。行号会漂，以「锚点语句 + grep」为准；注释自相矛盾那条采纳 |

同步复核补充（main@6e114a35）：远端新进的 25 个 commit 无任何 extraDirs/library 组合改动，无人抢跑实现；`feat(permissions): 支持外部可写目录 (#3587)` 只动 writableDirs 轴，与本方案的只读轴不冲突，反而证明 `applyDirectoryGrants` 双轴入口是活跃维护面。

PR0 契约已写入本文件与 plugin-library-storage.md。实现从 PR1 起；Mivo 红线文档由 kiro 改，宿主仓不代改。
