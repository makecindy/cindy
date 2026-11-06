# 官方飞书 / Lark 机器人：实现计划

> 状态：计划稿，待评审（2026-11-04 已确认：新建独立服务、只在海外部署一套、机器人单独配置应用）。产品体验以 [`official-feishu-bot-experience.html`](official-feishu-bot-experience.html)
> 第三版为准。基线：客户端 `makecindy/cindy` main `06d8d7d6c7`，服务端 `xindong/cindy-server` main `85dafefb8`。

## 1. 背景与目标

- 组织所有者/管理员在组织后台配置本企业的飞书或 Lark **企业自建应用**（机器人专用应用）。
- 组织成员在 Cindy「官方」栏关联飞书账号：授权页一键关联为主，关联码兜底（外部用户）。
- 私聊或群里 @Cindy，按**发言人**把任务派到其选中的工作电脑；群里在触发消息下的**话题**里回复；带群聊上下文。
- 体验对齐官方 Telegram：离线排队、断线补发、确认卡与 Cindy 共用决定、群任务强确认。
- Cindy 全局应用审批通过后可在后台切换，Cindy 侧不发版。

## 2. 总体架构

```text
飞书 / Lark ──(每个已启用应用一条长连接)──▶ feishu-hook-server（新，cindy-server 仓）
                                           │  多应用注册表：组织应用（库）+ 全局应用（后续，env）
                                           │  绑定 / 话题与私聊 lane / 任务队列 / 卡片渲染 / 管理 API
                                           ▼
                       Cindy Desktop（hook-control 新增 feishu lane，WSS 拨出，复用 dispatcher / session-runner）
组织后台 Console（auth-server/console）──HTTPS──▶ feishu-hook-server /api/org/feishu-bot（组织应用配置）
```

关键取舍：

| 决定 | 选择 | 理由 |
|---|---|---|
| 服务形态 | 新建独立服务 `feishu-hook-server`（用户 2026-11-04 确认） | 与 slack/telegram/x hook server 平级；独立库、端口、开关，故障不牵连 Telegram。并入 `oauth-broker-server` 不可行：它只做令牌交换、按区域各部署一套且各认本区账号，与「海外一套、两版账号都能用」冲突；并入 `telegram-hook-server` 可行但用户选择隔离 |
| 公共代码 | **复制** telegram-hook-server 的 `core/`（server、taskQueue、queryBroker、auth），并吸收 x-hook-server 的加固 | 仓内两次先例均为复制；抽 `packages/` 会让所有服务每次改动都重新部署 |
| 事件接收 | 飞书 SDK 长连接（`@larksuiteoapi/node-sdk` WSClient，按需加载），按 brand 切域名 | 企业自建应用支持；无需对外回调地址；个人飞书 bot 已验证两种 brand |
| 部署 | **只在海外（sgp-prod）部署一套**，单实例（`FEISHU_HOOK_SINGLE_INSTANCE=true`），同时信任中国大陆版与 Global 登录（`AUTH_ISSUER_CN` + `AUTH_ISSUER_GLOBAL`）；sh-dev 做测试环境 | 用户确认只部署一套到海外，与官方 Telegram 相同；长连接是集群投递（随机一个连接），多副本需要跨副本路由。中国大陆组织的应用凭证与关联关系也存于新加坡 |
| 应用凭证 | 由 feishu-hook-server 自己加密保存（AES-256-GCM，独立密钥 `FEISHU_HOOK_SECRET_ENC_KEY`） | 现有飞书凭证（插件/登录/通讯录）不对其他服务开放；Telegram/Slack hook 也自持凭证 |
| 消息排版 | **第一里程碑由服务端排版**：沿用 `turn.progress` / `turn.end` / `interaction.request`，服务端用移植自个人飞书 bot 的纯函数卡片构建（`cards.ts`）包成卡片；第二里程碑再切到电脑排版（msg.op） | 无需先扩 msg.op（卡片载荷、终稿 edit、图片上传）和重构 lizi-im；两端可各自上线；用户看到的卡片样式一致 |
| `source.im` | 固定 `'feishu'`（Lark 也是），会话来源复用 `'feishu'` | 与官方/个人 Telegram 共用 `'telegram'` 的先例一致 |
| 权限来源 | 官方飞书轮次的 origin 必须是 `{kind:'hook', source:'feishu'}` | 现有 `mainOwnedChannelOrigin('feishu')` 会把它当成个人 bot 的可信来源，绕过桌面确认（安全红线） |

## 3. 关键设计

### 3.1 应用与身份

- `FeishuApp`：`authEnv, orgId, orgSlug, brand(feishu|lark), appId, encryptedAppSecret, enabled, botOpenId, botName, botAvatarUrl, lastCheck*, createdAt, updatedAt`；
  唯一键 `(authEnv, orgId)`、`(brand, appId)`。
- 桌面连接验签后保留 `ctx / orgId / orgSlug`（现 telegram 丢弃）。连接时按「组织应用（已启用）→ 全局应用（后续）→ 无」解析应用；
  无应用时 welcome 不宣告 `provider:feishu`。
- `ProviderBinding.tenantId = appId`，`principalId = open_id`；一个飞书账号可绑定多台电脑，每台电脑在同一应用下只关联一个飞书账号；工作电脑在服务端按 `(appId, open_id)` 持久化选择，新关联的电脑默认选中，重连不改变选择。
- 组织更换应用（appId 变化）或切到全局应用：旧应用下的绑定置为 `superseded`，向在线桌面推 `reason: 'app_changed'`，卡片提示一键重新关联。

### 3.2 关联

- `provider.bind.start` → 服务端建一次性 attempt（10 分钟），同时生成：
  - **授权链接**：`https://accounts.{feishu.cn|larksuite.com}/open-apis/authen/v1/authorize?client_id=…&redirect_uri=…/feishu/oauth/callback&state=<token>`；
  - **关联码**：8 位分组码（只存哈希），经协议新增可选字段 `bindCode` 下发。
- 授权回调：`code` 换 `user_access_token`（`/authen/v2/oauth/token`）→ 取 `open_id / union_id / name / tenant_key` → 认领 attempt → 回结果页（中英）→ 机器人私聊「已关联」。
- 关联码：私聊发「关联 XXXX-XXXX」→ 按哈希认领；同一 open_id 10 分钟内错 5 次锁定；群里不处理。
- 新设备关联成功后，机器人私聊发送当前工作电脑与用法。在底部菜单「工作电脑」（事件 key `device`）或 `/device` 打开分页选择卡，列出所有已关联电脑与在线状态。选择仅影响新消息，运行中任务留在原电脑；离线 / 繁忙时拒绝，不自动切换电脑，不积压补发。
- 同一电脑更换关联账号仍需本人确认；桌面开关只解绑本机，私聊 `/unlink` 只解绑当前工作电脑。其他电脑及其运行中任务保留。

桌面端为本机已确认的绑定提供「设为工作电脑」，收到成功回执后才提示完成。这个操作不创建绑定，也不缓存可能因其它电脑切换而过时的状态标签；旧服务端不提供动作时隐藏按钮；重连后等待本连接的绑定快照再展示。解绑立即取消在途切换并忽略迟到回执。切换处理预算由服务端接收时开始计时，不依赖电脑时钟，断线或失败不重试。

### 3.3 lane（externalKey）

- 私聊：`feishu:dm:<appId>:<openId>:g<n>`（`/new` 换代）。
- 群：**每次在群主界面 @ 都开一个新话题 = 一个新任务**；话题内继续 @ 接着该任务。
  `feishu:topic:<appId>:<chatId>:<rootMessageId>:<openId>:g<n>`（以话题根消息 id 为键；同一话题里不同人各自一条 lane）。
- 话题群（每条消息都是话题）同一规则。服务端内部会话键按绑定隔离，每台电脑保留自己的代次、工作目录和上下文起点；外部 lane 格式不变。

### 3.4 入站（服务端，移植自 `packages/lizi-im/src/feishu/`）

- `(appId, message_id)` 去重；SDK 回调 3 秒内返回，处理异步进行。
- 私聊全触发；群需 @ 机器人（`/bot/v3/info` 取 bot open_id），回复机器人消息也算；只提名字不算。
- 「同时发送到群聊」双投递去重（`dualDelivery.ts`）、`parseIncoming`、@ 占位还原、引用/合并转发解析、附件下载（≤30 MB）。
- 群上下文：触发时用 `im.v1.message.list` 拉话题或群主界面最近记录（需「获取群组中所有消息」；无权限则只带触发与引用消息），
  经 `source.threadContext` 随任务下发，服务端不保存。
- 未绑定者 @：普通群用「仅你可见」卡片（`ephemeral/v1/send`），话题群回落普通回复；每人 60 秒一次。

### 3.5 出站（服务端排版，第一里程碑）

- 受理：触发消息加「OneSecond」表情，开跑换「Typing」，结束移除（保存 `reaction_id`）。
- 进度：首个 `turn.progress` 在话题/私聊发 v2 markdown 卡片（`update_multi`），之后 1.5 秒节流原地 patch；30 KB 截断。
- 终稿：`turn.end` 时把同一张卡 patch 成最终回答；图片附件上传为 `image_key` 嵌入卡片，文件单独发送；失败显示原因。
- 交互卡：`interaction.request` 渲染 v1 按钮卡；`card.action.trigger` → `interaction.decision`；群任务改投 owner 私聊并附来源链接；`interaction.cancel` 收口。
- 命令（第一里程碑）：`/new` `/stop`（`!stop`）`/device` `/status` `/unlink` `/help` `/project`（经 `query.request`）；`/ctr` `/model` 等与私聊菜单放第二里程碑。

## 4. 两个仓库怎么拆

依赖顺序：**协议 → 服务端与客户端并行（都默认关闭）→ 组织后台 → 部署与开放**。每个 PR 都能单独上线和回滚。

### 4.1 服务端（cindy-server）

| PR | 内容 | 主要文件 |
|---|---|---|
| **S1 协议** | `HOOK_PROVIDERS` 加 `'feishu'`；`HOOK_FEATURE_PROVIDER_FEISHU='provider:feishu'`；`ProviderBindStatusPayload.bindCode?` 与 `copy_bind_code` 动作及校验；fixture | `packages/slack-hook-protocol/src/{types,parse}.ts`、`__tests__/protocol-provider.test.ts` |
| **S2 服务骨架 + 组织应用 API** | 复制 core（server/taskQueue/queryBroker/auth 保留组织声明）、config 与开关、Prisma（`FeishuApp` + 中立表 + `FeishuEventReceipt/MessageRoute/InflightReply/DeviceDeclaration`）、加密、应用注册表与长连接、`/api/org/feishu-bot` 增删改查与检查（`capabilities.manage`、`expectedUpdatedAt` 并发保护、凭证与 bot 信息校验）；CI 与仓库登记 | `feishu-hook-server/**`；根 `package.json`（`feishu:*`）、`.gitignore`、`.github/scripts/select_service_ci.py`（必改）、`.github/workflows/service-directory-ci.yml`、`README.md`、`docs/README.md`、`docs/feishu-hook-server.md`、`docs/commit-convention.md`、`AGENTS.md` |
| **S3 关联** | 授权链接 + 回调结果页、关联码、换绑确认卡、解绑、绑定同步帧、换应用作废 | `feishu-hook-server/src/feishu/{bind,oauth}.ts` 等 |
| **S4 消息主链** | 入站解析与去重、lane、任务派发与离线提示、服务端卡片渲染（进度/终稿/交互）、表情、附件、群上下文、未绑定提示、第一里程碑命令 | `feishu-hook-server/src/feishu/{controller,inbound,cards,client,lanes}.ts` 等 |
| **S5 组织后台** | auth-server 下发 `feishuHookApiBaseUrl`（client-config + CSP；中国大陆与 Global 两套 auth-server 都配置为同一个海外地址，服务端 CORS 放行两个区域的后台域名）、Enterprise 契约文档同步；Console「飞书机器人」卡片与配置向导（平台选择、权限清单与批量导入、事件与重定向地址复制、凭证填写与检查、启用开关），中英文案 | `auth-server/src/{config.ts,routes/auth.ts,middleware/securityHeaders.ts}`、`auth-server/console/src/{api/clientConfig.ts,api/feishuBot.ts,pages/org/*,main.tsx,i18n/*}`、`docs/auth-server/auth-server-api.md`、`docs/enterprise-api-server/client-config.md` |
| **S6 部署登记** | 先 sh-dev，再 sgp-prod（只此一套生产实例）；状态页登记；Helm values 与密钥由运维仓 `XDMaker-k8s-helm` 配置 | `.github/scripts/deployment_state.py`、`status-server/src/catalog.ts` 等 |

### 4.2 客户端（cindy）

| PR | 内容 | 主要文件 |
|---|---|---|
| **C1 协议与端点** | 同步 S1 协议；新增端点键 `feishuHookWsUrl`（`wss:`；两个区域清单指向同一个海外地址，登记为跨区域端点键，与 `telegramHookWsUrl` 相同；正式清单暂不填 = 入口隐藏） | `packages/slack-hook-protocol/**`、`packages/maker-shared/src/clientEndpointSchema.ts`、端点 fixture |
| **C2 桌面主进程** | `manager.ts` 新增 feishu lane 配置行；store 字段；ipc / preload / 类型放宽；`providerRouting` 认 `feishu:`；`feishuDeepLink.ts`（授权页与 applink 域名白名单）；dispatcher / session-runner：origin 特判为 hook、`vendorOptions.source='feishu-hook'`、Feishu/Lark 提示说明、话题 lane 视为群轮次（强确认）；会话来源写入 | `apps/desktop/src/main/hook-control/{manager,ipc,store,providerRouting,dispatcher,session-runner,outbound,workspacePrefsStore,workspaceProviderSourceStore}.ts`、新 `feishuDeepLink.ts`、`main/localDb/ipc/sessions.ts`、`main/mcp-integrations/ghostSetupInteractionSurface.ts`、`packages/lizi-mcps/src/cindy_feishuBotMcpServer.ts`、`shared/hookControlIpc.ts`、`preload/preload.ts`、`renderer/vite-env.d.ts` |
| **C3 设置界面** | 「官方」栏飞书/Lark 卡片：仅组织账号显示，组织未配置时专用提示；授权页打开/复制链接、关联码显示与复制、打开机器人、解绑、换应用提示；工作目录映射与默认偏好；设置搜索；任务卡图标；12 种语言与术语表 | `renderer/components/settings/{HookConnectionsSection,HookWorkspacePrefsEditor,ImBotSection.settings-search}.tsx`、`renderer/components/chat/HookTaskCard.tsx`、`renderer/i18n/locales/*/common.json`、`i18n/glossary.json` |
| **C4 规则文档** | 新增产品规则 `docs/product-rules/official-feishu-bot.md`（本次裁决）；更新 protocol-compatibility、im-turn-flow、im-permission-confirmation、message-source、telegram-bot-parity（官方渠道清单）、provider-sharing、region-and-editions | `docs/**` |
| **C5 开放** | 服务端部署后，在 `config/endpoint*.json` 填 `feishuHookWsUrl` 并上传 CDN 清单（无需发版） | `config/endpoint.json`、`config/endpoint.global.json` |

### 4.3 第二里程碑（第一期上线后）

- 电脑排版：重构 `packages/lizi-im/src/feishu/streamingText.ts` 抽出 `FeishuStreamingDeps`，个人与官方共用；协议新增
  `feishu-progress/final/card-ops-v1`（卡片载荷、终稿 edit、图片上传）；服务端只做授权与代发。
- `/ctr` `/model` `/settings` 卡片、私聊底部菜单事件、全局应用（env）与组织切换、旧机器人 7 天更换提示、免关联（复用登录/通讯录应用的身份）。

## 5. 上线顺序与兼容

1. S1 + C1 同步合入（新增可选字段，旧端忽略；S1 会触发服务端全服务 CI）。
2. S2–S4 合入，服务默认关闭、不进部署清单；C2–C3 合入，因端点为空入口不显示。
3. S5 合入后部署 sh-dev，组织后台配置公司测试应用，本地 `endpoint.local.json` 指向开发环境联调。
4. sgp-prod 生产部署 → 两个区域的组织后台都指向这一个服务地址 → 后台配置公司应用 → C5 更新两个区域的 CDN 端点清单开放。

任一端单独回滚：服务关闭开关或撤端点即隐藏入口；旧客户端看不到 `provider:feishu`，不受影响。

## 6. 验证

- 服务端：`pnpm feishu:typecheck && pnpm feishu:test && pnpm feishu:build`；复制来的 core 测试一并移植；控制器用假飞书客户端 + 假 auth-server（`helpers/fakeAuthServer.ts`）覆盖关联、lane、去重、离线、换绑、换应用；Prisma 合同测试用本地库（`FEISHU_HOOK_TEST_DATABASE_URL`）。
- 组织后台：Console 页面 vitest 与 `design-system.test.ts` 门禁；本地起 console 走完配置向导。
- 客户端：`pnpm test:unit:related`；`pnpm --filter <包名> run --if-present typecheck`（desktop、slack-hook-protocol、maker-shared、lizi-mcps）；`pnpm check:endpoints`、`pnpm check:i18n`、`pnpm check:i18n-glossary`、`pnpm check:test-hygiene`；`session-runner` 补「官方飞书 origin = hook」回归用例。
- 端到端（sh-dev + 公司测试应用）：授权页关联、关联码关联（外部账号）、私聊任务、群 @ 开话题、话题内续聊、确认卡两端同步、电脑离线排队、解绑、换绑、更换应用后重新关联；飞书与 Lark 各走一遍；浅色/深色界面各看一遍。

## 7. 风险与需要注意的规则

- **权限边界**：origin 特判漏掉会让官方飞书轮次绕过桌面确认，必须有回归测试。
- **协议兼容**：两仓 `slack-hook-protocol` 同步维护；只做可选新增。
- **提示词**：`buildHookPromptNote` 进入模型上下文，改前读 `docs/dev-rules/maker-core-and-agent-behavior.md`。
- **单实例**：长连接集群投递，扩副本前需要跨副本路由。
- **组织侧依赖**：「获取群组中所有消息」需要企业飞书管理员审批；未开时功能自动降级。
- **凭证**：新加密密钥由运维注入；App Secret 只写不读，日志与协议帧不出现。
