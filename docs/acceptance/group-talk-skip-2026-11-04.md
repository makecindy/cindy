# 群聊轮流发言：客户端跳过入口验收

日期：2026-11-04。基于 `main@2c380c9ac88514fda46139bdae2b3c66aeac9818`。
服务端配套：[xindong/cindy-server#1239](https://github.com/xindong/cindy-server/pull/1239)。

## 范围与行为

- Desktop 和 Mobile 讨论队列卡采用统一的紧凑气泡布局；超过 4 位时折叠为当前附近的 3 位。
- 当前执行仍为 `queued` 时显示「等待开始」，并在有管理权限时提供「跳过」。
- 后续 `pending` 成员仅在服务器声明 `supportsPendingSkip: true` 时提供跳过入口。
- 已运行、已完成、已跳过、已停止或无管理权限时，不提供该项跳过；在途操作期间禁用按钮。
- 当前项请求保留界面显示的 `executionId`，不因刷新而替换成另一次执行；后续项只传位置。
- Desktop、Mobile 直连 Chat Server、Mobile 经被控 Desktop 三条入口保留相同协议字段。
- 分工依赖、全局停止、自动推进上限和服务端调度仍由原有机制及配套服务端 PR 负责。
  不增加自动离线跳过、唤醒设备、换电脑代执行或重新安排伙伴的能力。

## 协议和发布顺序

新增投影均为可选：`activeExecution`、`supportsPendingSkip`；已有 plan-edit 增加 `skip`，
共享视图增加 `skipped`。当前项带执行 ID；未来项不需要执行 ID。服务端最终核验权限、
revision、执行状态和领取竞态，客户端按钮不是授权边界。

新客户端连旧服务端或旧被控 Desktop 时，不凭位置猜执行 ID，不显示缺乏相应能力的跳过入口。
收到 `TURN_ALREADY_STARTED` 或 revision 冲突时显示原因并沿既有路径刷新，不把失败显示为跳过成功。
Mobile 远控仍使用既有 `bot-groups` / `plan-edit`，无 Device Link 帧、allowlist、自建中转改动。

服务端所有副本先升级，再启用新版客户端入口。旧客户端未必认识 `skipped`，不能承诺旧界面正确展示
新状态。已经持久化跳过结果后，不能把服务器回退到不认识它的旧实现；优先向前修复。
客户端可回退到本 PR 前版本，但会失去跳过入口和新状态展示。无数据库迁移、原生依赖或指纹改动。

## 验证证据

| 验证 | 结果 |
| --- | --- |
| Desktop Chat Server 适配、远控资源、真实群聊视图 3 个测试文件 | 731 项通过；视图旧断言按新设计更新后独立重跑 226 项通过 |
| Mobile 卡片、远控解析、直连 client 和 hook 4 个文件 | 366 项通过 |
| 共享展示与动作判据 | 80 项通过 |
| Mobile 字体、文字色和主题 guard | 34 项通过 |
| Desktop / Mobile package typecheck | 通过 |
| maker-shared `build`（tsc） | 未通过：`botGroupProcess.ts:95` 的 ES2022 / `findLastIndex` 两条错误；同一依赖下纯主干快照完全复现，不属于本 PR |
| `check:i18n`、`check:i18n-glossary`、`check:test-hygiene`、`git diff --check` | 通过；i18n 既有告警保留 |
| `check:dev-docs` / `hardcoded-color-audit --worktree` | 10 项文档检查通过；无新增硬编码颜色，3 条布局/圆角人工提示按用户设计稿及 DESIGN §5 核对 |
| `pnpm test:unit --workspace-concurrency=1` | 根 runner 638 项通过、2 项跳过；随后工作区套件因 `DEPENDENCY_SETUP_INCOMPLETE` 未运行，本机 Electron 包缺少 `dist/version`，未安装依赖或绕过检测 |
| Electron 单组件矩阵 | 实际构建和加载生产 `BotGroupPlanCard`，7 状态 × 2 主题 × 中英文 × 2 尺寸（600×500、360×640），56 个组合通过 |
| 最终文案的 Electron 复核 | default 及跳过交互 × 12 语言 × 2 主题 × 2 尺寸，48 个组合通过；最终中文状态为术语表规定的「运行中」 |
| `ui:check --changed --theme all --engine electron` | 已尝试，但共用翻译文件使其选中大量无关页面；本任务在扩大扫描中止自己的 runner 以控制资源，不能宣称该全覆盖命令通过 |

组件 fixture：`apps/desktop/scripts/fixtures/group-talk-skip/`。使用生产组件、按钮、样式、翻译及共享判据。
截图中的队列为示例数据；点击后的服务端回执由 fixture 模拟，不能作为真实服务器调度验证。
PR 正文附最新公开截图与 `ui:check` 报告。中英文深浅色总览已目检，最终中文宽/窄屏已检查；
12 语言均经过结构/术语检查和组件布局检查，不宣称全部母语审校。

## 测试价值与覆盖缺口

本次扩展已有文件，不新增测试框架。以下均为 unit，模拟网络/宿主，验证实际生产入口：

| 文件 | 生产行为、缺口与最小输入 |
| --- | --- |
| Desktop `chatServer.test.ts` | 旧适配不投影执行 ID/能力。给一个 queued 当前项并在刷新后换执行 ID，检查发送仍带用户点击的旧 ID；后续项不带 ID |
| Desktop `botGroupRemoteResourceProvider.test.ts` | 手机的执行 ID 原先未透传；调用真实资源 plan-edit，检查到达适配层的参数 |
| Desktop `BotGroupChatView.test.tsx` | 真实视图按已确认的紧凑设计展示/折叠；waiting talk 队列不再提供服务端拒绝的换人菜单，有权限才发送未来位置 skip，无权限不发送 |
| Mobile `BotGroupChatScreen.test.tsx` | 真实卡片在六人队列折叠、展开，queued 当前项可跳；转为 running 后该项不能跳，后续项仍可跳 |
| Mobile `botGroupRemote.test.ts` | 原解析丢弃管理权限、执行身份和 skipped；输入包含这些字段的快照及旧端快照，检查保留/兼容 |
| Mobile `chatServerClient.test.ts` | 真实客户端发送精确执行 ID/位置和 revision，拒绝 running/work/旧服务器未来项，不产生错误 POST |
| Mobile `chatServerMobileEntry.test.tsx` | 真实 hook 的未来项无执行 ID，验证不会被输入校验错误拦下 |
| Shared `botGroupPresentation.test.ts` | 两端共用判据：queued 与 running、权限、旧端能力缺失、skipped 后的继续和 work 依赖隔离 |

大型既有 Desktop 视图文件独立运行 21.42 秒，覆盖 226 项真实交互；未放宽 timeout 或断言。
其余文件在定向批次中的测试体耗时（不含收集/转换，并非单文件墙钟）：Desktop 适配 5625ms / 472 项、
远控资源 52ms / 33 项；Mobile 卡片 4266ms / 163 项、hook 324ms / 75 项、client 57ms / 86 项、
远控解析 15ms / 42 项；共享文件独立总耗时 726ms / 80 项。
既有大文件的测试数量与加载成本保留，不扩大重构；不把矩阵数量当作完整产品覆盖率。

## 仍未验证

- 原生 iOS/Android 构建、Mobile 实机字体/点击区域；Electron 窄屏截图不是 Mobile 原生验收。
- 真实账号、群聊、离线电脑、领取/跳过竞态、服务端滚动升级与跨设备端到端。
- 本轮未重放用户原群、唤醒离线伙伴、发群消息、合并或部署。
- 当前 PR CI / 自动审阅与维护者确认需独立完成；尚未找到准确关联的需求 Issue。

## 评审修复：真实时间线宽度与 Mobile 操作字号

- P1 已在 Electron 中先复现：把原 fixture 改为挂载生产 `BotGroupTimelineItem`，
  使用其真实的自动宽度父层后，600×580 默认场景触发卡片宽度塌缩断言。
  修复只让讨论队列的两层父容器占满受限列宽，保留共享 720px 上限和操作栏留白，
  不修改普通消息或分工卡；卡片的容器查询保持原样。
- P2 按 Mobile 设计指南 §4 聊天卡片按钮规格，将跳过/展开/收起文字改为
  `bodySmall` 15/20 medium、`textPrimary`，触控区域不变。
- 同一生产时间线 fixture 修复后，7 状态 × 2 主题 × 中英文 × 3 视口
  （360×680、600×580、1000×580），Electron 84/84 通过；包含尺寸回归、折叠及跳过交互。
  Electron 42.11.12 / Chromium 148.0.7778.280，无模块替换。已目检默认场景三种尺寸的深浅色截图。
- Desktop 真实群聊视图 226 项、Mobile 真实卡片及三个设计 guard 197 项通过。
  Desktop/Mobile package typecheck、test-hygiene、dev-docs 与 diff 检查通过。
  本轮仅复核局部样式；Mobile 原生渲染、真实群调度仍未验证。
- 本轮沿用定向 `ui:check --page group-talk-skip`，不重复此前因共用翻译命中大量无关页面的
  `--changed` 全扫描。完整门禁继续由本次新 head 的 CI 执行，旧 head 的 5/5 不沿用。
