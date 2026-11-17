# PR 状态的合并就绪字段

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`PrStatusResult`（`git-context:pr-status`，含 device-link 远程会话）成功结果新增可选 `mergeState`、`reviewDecision`，
取自同一次 GraphQL 汇总查询的 `mergeStateStatus` / `reviewDecision`，不增加请求。GitHub 插件 PR 卡片的状态位
（`data-ghost-pr-status`）用它显示「可以合并 / 有冲突 / 等待审批」。旧控制端忽略字段；新控制端连接旧宿主时字段缺失，
卡片省掉这一项而不是猜测。不改握手、白名单、relay 或服务端，无数据库迁移。
回归入口：`gitContextPrStatusService.test.ts`、`ghostCardPrStatus.test.ts`。

插件卡片可在 `div` / `span` / `button` 上标 `data-ghost-pr-open-only="owner/repo#N"`：标题栏同源状态为已合并或已关闭时，
电脑端藏起这些元素，手机投影在宿主侧把它们连同文字、`live` 与按钮一起去掉，所以新旧手机都无需改动；查不到状态时照常显示。
手机只对含 PR 状态位或 PR 链接的卡片定时重读，带该标记的卡片需保留其中之一（GitHub 插件的 PR 卡片标题始终链接到 PR）。旧宿主的净化器丢掉这个属性，卡片维持原快照。不改握手、白名单、relay 或服务端，无数据库迁移。
回归入口：`cardSanitizer.test.ts`、`cardRemoteResource.test.ts`、`ghostCardPrStatus.test.ts`。

插件卡片可放一颗归档任务按钮：`button` 上标 `data-ghost-task-archive="owner/repo#N"`（不得同时带 `data-ghost-action`
或 `data-ghost-link`，否则净化器丢掉这个标记），可选 `data-ghost-task-archive-state="merged|closed"`（插件读到的状态快照）
与空值 `data-ghost-task-archive-auto`（用户开了「合并后自动归档」）。插件把它写成 `display:none`，文字放在 `aria-label`
并用自己的 `::before` 画出来。新电脑端按标题栏同源状态确认任务全部关联 PR 已合并后以 `inline-flex` 露出，并将 `aria-label` 更新为「立即归档」（查不到状态时不显示），
点击不回传插件，由任务页走与标题栏归档相同的流程，只作用于卡片所在任务。带 `-auto`、宿主自己查到已合并，且任务页满足静态资格（`canAutoArchiveOnLeave`：普通任务页、本机任务、任务还是活跃的、没有被远程写入拦截）时，
自动归档待生效：宿主在按钮左边插入自己的「离开此任务后将自动归档」与独立描边按钮「取消」（文字与点击都归宿主），卡片在可见、聚焦的窗口里
进入视野记为「看过」（只在内存）。用户点「取消」，或待生效之后任务里出现用户发的消息（本机发送立即取消，但只取消已经待生效的，合并前发的消息不算；
手机、IM、共享成员的消息在历史加载完成后按最后一条用户消息比较；官方 IM Hook 的渠道消息虽然复用 scheduler 形态的 origin，但是真人发的，要算；真正的自动化与插件代发的不算），本次就取消，提示改为「本次不会自动归档」，直到任务里不再有符合条件
的卡片才重新开始。同一任务可以有多张卡片，按卡片登记资格，任一张符合就待生效，只有符合条件的那张卡片在眼前显示才记「看过」。
提示只在静态资格成立时显示，离开时用同一个判断（IM 接管状态只能在任务所在电脑上查，远程任务没有确认框兜底就不静默收走，卡片上的归档按钮照旧可用），所以提示不会承诺一次不会发生的归档。
离开普通任务页（包括直接切到另一个任务，按离开那个任务最后一次渲染的信息处理）时，看过、没取消、任务没在运行、没被接管、
确认没有绑定活跃定时任务（读取失败、超时、上次刷新失败后留下的旧缓存，都算不确认，保留任务）、输入框没有草稿、worktree 确认干净且用户没有
回到它，才静默归档并给可撤销提示，否则不归档也不弹确认。旧电脑端的净化器丢掉这些属性，按钮一直藏着。
状态机（登记、待生效、看过、取消、最后一条用户消息）在 `@cindy/maker-shared/ghost-card-task-archive`，电脑与手机各建一份内存实例。

手机：按钮没有动作和文字，普通投影从不带它，旧手机照旧不显示。声明 `plugin-card-rich` 的手机读卡片时，宿主在
`plugin-card-actions` 的 `data` 里可选附带 `taskArchive: { auto: boolean }`：只在这张卡片的 PR 与任务全部关联 PR 都按标题栏
同源状态确认已合并（`readSessionPrsAllMerged`，与 `areAllTaskPrsMerged` 同一判据和 30 个上限）时才带；`auto` 为插件标了
`-auto` 且任务没被 IM 接管（只有任务所在电脑能查，所以由宿主算好）。新手机据此画「立即归档」（走菜单同一归档流程）、
待生效提示与「取消」；卡片在聚焦的任务页、App 在前台且消息行确实在视野内才记「看过」。离开任务页（页面卸载或原地换任务）时，
手机再读一次符合条件的卡片确认 `auto` 仍为 true，并确认任务仍活跃、没在运行、`maker:schedule:list` 读到没有绑定活跃自动化
（超时或失败算不确认）、手机输入框没有草稿、既有 `worktree:removal-preview` 确认干净（失败算不干净）、用户没回到这个任务，
才用既有 `local-db:sessions:patch-meta` 归档，并在应用底部给 8 秒可撤销提示。新手机连旧电脑收不到 `taskArchive`，不显示按钮。
不新增 channel、白名单、握手、relay、服务端或数据库迁移，也不改变 Mobile 原生 fingerprint。
回归入口：`cardSanitizer.test.ts`、`cardRemoteResource.test.ts`、`ghostCardPrStatus.test.ts`、`useGhostCardTaskArchive.test.tsx`、
Mobile `pluginCardActions.test.tsx`、`useTaskAutoArchive.test.tsx`、`archiveScheduleConfirm.test.ts`。
