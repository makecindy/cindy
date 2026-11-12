# 伙伴 Telegram / 飞书陌生私信：核查与热修复测

核查日期：2026-11-11。产品代码提交：92d2ce114ff83f112f3208626a25867ecebd9576。
自动测试基线：4e162cdbbc；另与核查版本 d386dc764f 比较，以下关键入口与权限代码一致。

本文记录代码核查、已执行的自动验证及待执行的真实账号复测。真实平台互发、安装版升级和完整界面验收尚未完成，不能据此宣称线上问题已经修复。

## 根因与影响

设置中的个人 Telegram bot 默认拒绝陌生私聊，但伙伴「消息平台」中的 Telegram 工厂写死 guestDm: true。
陌生人的普通私信会带 speaker.isOwner=false 派发给业务层，进而进入 Agent；只拦截斜杠或感叹号命令不足以阻止普通问句触发工具。
飞书伙伴的 guests: true 同时开放群 @ 和非主人私聊，存在同类缺口。

独立访客专线只分开交流历史，仍共享伙伴的 Profile、Home、工具及记忆。
“发言人不是主人”的模型提示不是宿主访问控制，写入或破坏性工具策略也不能保证本地资料不被读取。
Auto 有自己的审核及部分引擎的目录边界，但可能自动放行；伙伴的完全访问会豁免逐轮策略。
因此不能笼统承诺“危险操作必定逐次交给主人确认”，也不能以独立任务推断资料已隔离。

修复前证据：

- [伙伴 Telegram 工厂](https://github.com/makecindy/cindy/blob/d386dc764f/apps/desktop/src/main/im/host.ts#L237-L250)
- [Telegram 私聊准入与派发](https://github.com/makecindy/cindy/blob/d386dc764f/packages/lizi-im/src/telegram/index.ts#L1730-L1779)
- [Telegram 逐轮策略](https://github.com/makecindy/cindy/blob/d386dc764f/apps/desktop/src/main/im/telegram/permissionPolicy.ts#L19-L26)
- [共享工具策略](https://github.com/makecindy/cindy/blob/d386dc764f/apps/desktop/src/main/im/shared/channelToolPolicy.ts#L138-L199)
- [Auto 的访客读取口径](https://github.com/makecindy/cindy/blob/d386dc764f/apps/desktop/src/main/maker-host/auto-permission-reviewer.ts#L190-L192)
- [伙伴完全访问豁免](https://github.com/makecindy/cindy/blob/d386dc764f/apps/desktop/src/main/im/telegram/adapter.ts#L209-L220)

报告中的陌生私信进入正常 Agent 对话现象与伙伴入口吻合；仅凭聊天截图不能确定具体安装版本、连接入口或回答来自当轮工具、既有上下文还是共享记忆，不将路径推断当成具体用户设备的取证结论。

## 渠道核查

| 入口 | 修复前私聊准入 | 本次处理 |
| --- | --- | --- |
| 个人 Telegram bot | 配置 owner ID，不匹配即固定拒绝并返回 | 保持 |
| 伙伴 Telegram bot | 普通陌生私信因 guestDm=true 被放行 | 删除放行选项，在传输层一律先验 owner |
| 飞书 / Lark 伙伴 bot | guests=true 绕过绑定后的私聊 owner 检查 | 群准入与私聊检查分开，私聊始终验 owner |
| 企业微信 | emitInbound / acceptOwner 在 normalize、emit 前检查 owner | 保持 |
| 钉钉 | processEnvelope 拒绝非 owner 私聊 | 保持 |
| Discord | handleDmMessage 精确检查配置的 owner ID | 保持 |

飞书、企业微信、钉钉仍沿用首个单聊者 TOFU 认主；本次修复不替换首次绑定方式。
官方 hook 的独立服务端不在此次跨仓修改范围内。

## 修复边界

- Telegram 在附件处理、typing、emitMessage 前拒绝非 owner 私信。未过期消息只尽力发送固定拒绝提示，每位陌生人 60 秒最多一次。
- 飞书私聊在内容解析、附件下载和业务派发前验 owner；guests 只用于群 @ 准入。
- 保留主人私聊、现有群 / 话题准入、群工具权限及历史路由。
- 同步帮助源稿和生成内容、伙伴平台页全部 12 种语言的说明，以及 Telegram / 伙伴行为台账。
- 不修改数据库或凭证结构，现有连接无需重绑；旧访客任务及历史不删除，新陌生私信无法再次触发。
- 不追溯撤销升级前已受理的工作，也不能收回已经泄露的信息。

当前不增加重新开放陌生私聊的开关。名单或配对码只解决准入身份；未来安全开放还需访客专属读取目录、记忆 / 上下文隔离、shell / MCP 与跨任务授权，以及非主人不继承完全访问豁免的宿主边界。仅改用 channelForceConfirmMutatingToolCall 仍会放行只读工具，不能独立解决资料泄露。

## 已执行的自动验证

产品代码提交保持不变，新增本文时复用下列仍适用的验证结果。

| 检查 | 结果 |
| --- | --- |
| 新回归先在修复前代码执行 | 2 项均失败，两个平台均派发了陌生私信 |
| 修复后定向回归 | 2 项通过，总时长 443 ms |
| IM 包完整测试 | 57 文件、958 项通过，总时长 24.93 s |
| Desktop 适配器 / 策略及伙伴平台页 | 4 文件、56 项通过 |
| Desktop typecheck、改动 TS 的 ESLint | 通过 |
| i18n key / 术语、帮助生成同步 | 通过；无关存量警告保留 |
| 文档契约、测试卫生、diff / DCO | 通过 |

对应命令（从仓库根执行）：

    pnpm --filter @cindy/im exec vitest run --maxWorkers=1
    pnpm --filter @cindy/im exec vitest run src/telegram/__tests__/telegramIM.test.ts src/feishu/__tests__/wsClientGroup.test.ts -t '伙伴连接的旧 guestDm|guest group access'
    pnpm --filter desktop exec vitest run src/renderer/features/bots/__tests__/botChannelsPage.test.tsx src/main/im/telegram/__tests__/adapter.test.ts src/main/im/telegram/__tests__/permissionPolicy.test.ts src/main/im/feishu/__tests__/permissionPolicy.test.ts --maxWorkers=1
    pnpm --filter desktop typecheck
    pnpm check:i18n
    pnpm check:i18n-glossary
    node apps/desktop/scripts/help-kb-guard.mjs
    pnpm check:dev-docs
    pnpm check:test-hygiene
    pnpm check:dco

本地全量门禁未执行；`86cf013d88` 的 20 项 PR CI 已通过。新增测试后的提交仍须等待对应 head 的 CI。
上述测试使用平台内存 fake，不是线上平台互发测试。

### 测试价值

| 文件 | 真实入口与覆盖缺口 | 最小失败输入、结果与 tier | 实测耗时 |
| --- | --- | --- | --- |
| packages/lizi-im/src/telegram/__tests__/telegramIM.test.ts | TelegramIM 公开入站事件；原默认个人 bot 用例没有覆盖旧伙伴的 guestDm=true | 绑定主人后，旧伙伴选项加非主人普通私信；必须无业务事件，同时保留 owner DM / 群 @，重复陌生私信只发一次提示；unit | 两条新回归定向运行合计 443 ms；128 例整文件测试执行 13.10 s |
| packages/lizi-im/src/feishu/__tests__/wsClientGroup.test.ts | SDK 注册的入站 handler；原默认 scope 未覆盖开放群成员的伙伴配置 | guests=true 加已绑定后的非 owner p2p；必须无业务事件，owner p2p / 群 @ 保持可用；unit | 18 例整文件测试执行 19 ms |

Telegram 现有大文件超过单文件建议预算；新用例没有新增真实等待或测试文件，不为本次热修重构无关连接 / 轮询用例。

## 补充：公用飞书应用的两个已授权用户

2026-11-11 按 review 中提出的 A / B 场景补测。客户端产品实现仍为 `92d2ce114f`，
仅新增回归测试与本文说明；服务端测试冻结在 `xindong/cindy-server` 的
`b6539e62acd1b021a90c6eb4e06fe5a6e0fee4e9`，未修改或发布服务端代码。

这里区分两条实际入口：

- 官方公用应用：服务端按 `appId + senderOpenId` 查各自关联，再经官方 hook 派发。
  [服务端入口](https://github.com/xindong/cindy-server/blob/b6539e62acd1b021a90c6eb4e06fe5a6e0fee4e9/feishu-hook-server/src/feishu/controller.ts#L2069)
  与本 PR 修改的自建 bot `wsClient` 私聊门禁不同。
- 自建机器人接入伙伴：同一连接只认绑定的主人。B 仅获准使用飞书应用，仍不等于获得
  A 伙伴的私聊访问权；原先多人可私聊同一伙伴的用法会被本热修关闭，群 @ 准入保留。

### 实际运行的自动验证

| 层级 | 执行与观察 | 结果 |
| --- | --- | --- |
| 客户端新增组合回归 | 同一 `cli_app`，A / B 分别有已确认绑定和独立 Cindy 账号 / 设备；各自私聊可派发，交叉投递被拒，解绑 B 后 A 仍可派发 | 新用例通过，2.76 s，其中测试执行 7 ms |
| 客户端相关整文件 | `transport-manager.test.ts` 完整运行，包含新增组合回归 | 138 项通过，总时长 14.09 s |
| 服务端生产控制流 | 现有 `controller.test.ts` 中双用户关联等选集；经 `handleBindStart`、`handleOAuthCallback`、消息接收、任务派发与回执路径 | 14 项通过，144 项未选中，总时长 642 ms |
| Desktop 类型检查、测试卫生、diff 检查 | 本次新增测试后的版本 | 通过 |
| 测试文件 ESLint | 与未补测试的 `86cf013d88` 比较完整 ESLint 结果 | 两者均有相同 3 项既有 unused findings，无新增；文件级 ESLint 未全绿 |

客户端命令：

    pnpm --filter desktop exec vitest run src/main/hook-control/__tests__/transport-manager.test.ts -t '同一公用飞书应用' --maxWorkers=1
    pnpm --filter desktop exec vitest run src/main/hook-control/__tests__/transport-manager.test.ts --maxWorkers=1
    pnpm --filter desktop typecheck
    pnpm check:test-hygiene

服务端命令（在上述冻结版本的独立测试 worktree 运行）：

    pnpm --filter @cindy/auth-verify build
    pnpm --filter feishu-hook-server exec vitest run src/__tests__/controller.test.ts -t 'store app multiple Feishu accounts|binds through the OAuth callback|dispatches bound DMs' --maxWorkers=1

新增客户端测试的价值：生产入口是官方 hook manager 的入站帧处理；要保护公用应用多个用户
各自的绑定、派发和解绑隔离，防止将伙伴单主人规则误用到公用应用。原测试只覆盖一个
manager 下的本机用户 / 其他用户判定，没有两个 manager 并存的组合。最小输入为同一应用的
两份已确认绑定和两条私聊；测试属于 unit tier，纯内存帧，不新增 socket、子进程或真实等待。
整文件包含原有真实 loopback WebSocket / 看门狗用例，实测超过 10 s；新用例自身执行 7 ms，
本次未改动这些既有资源测试或提高 timeout。

服务端的 OAuth code exchange、用户资料与飞书发送 API 均由内存 fake 提供；关联回调、
绑定存储控制流、派发与回执使用生产代码。客户端新增测试直接输入已确认绑定快照，
不验证真实 OAuth。以上结果不能等同于真实飞书账号授权或平台互发通过，也不能证明当前
线上服务与该冻结服务端版本一致。真实 A / B 互发仍为未验证。

## 待执行的真实账号复测

使用隔离测试资料、专用 bot 和两个不同的平台账号 A / B；A 先完成主人绑定，B 作为非主人。飞书不要让 B 成为首个 TOFU 绑定者。

| 场景 | 操作 | 预期与需要核对的证据 |
| --- | --- | --- |
| Telegram 伙伴陌生 DM | B 发普通问句；再发重复消息、命令和带说明文字的附件 | 最多一次固定拒绝 / 60 秒；无新 Agent 轮次、工具调用或附件下载，旧访客专线也不续跑 |
| Telegram 主人 DM | A 发普通消息 | 正常进入伙伴主任务 |
| Telegram 群 / 话题 | A / B 按既有允许的方式 @ bot 或回复 | 正常进入对应群 / 话题专线，成员不会被当成主人；不将本项通过解释为资料沙箱 |
| 个人 Telegram 回归 | 在设置中的个人 bot 重复 A / B 私聊 | A 正常，B 仍只走固定拒绝 |
| 飞书 / Lark 伙伴 | A 绑定后，B 发 p2p，再在已准入群 @；A 发 p2p | B 私聊无业务派发；A 私聊和已有群 @ 正常 |
| 官方公用飞书应用双用户 | A / B 各自完成与自己 Cindy 的关联，在同一公用应用里分别私聊发送不同的本轮测试标记 | 两人都能收到各自回复；B 不被当作 A 的陌生人拒绝；任务与回复不串到另一人的 Cindy |
| 旧连接升级 | 保留现有配置升级 / 重启后再次执行以上步骤 | 无需重绑；旧 guest 私信放行不会恢复 |
| 完全访问 | 对伙伴切换至完全访问，再由 B 私聊 | 仍在传输层拒绝，不受工具权限档位影响 |
| 界面说明 | 伙伴设置 → 消息平台，Light / Dark 查看更新说明 | 不再声称所有人可私聊或隐藏任务自动隔离资料；检查中英文等长文换行 |

真实 Telegram / 飞书互发、安装版升级、Light / Dark 截图与完整客户端验收均尚未执行。合并 / 发布前须记录实际测试版本与结果；复测材料不包含 token、真实项目清单、账号标识或本机绝对路径。
