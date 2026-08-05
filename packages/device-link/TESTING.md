# device-link 自动化测试策略(本地可全量跑)

> 跨设备远程控制(device-link)横跨三层:**relay 服务端(`apps/server`)→ 共享协议/客户端包(`@cindy/device-link`)→ 桌面端(`apps/desktop` main + renderer)**。本文件是这条链路的测试架构与覆盖契约,所有 device-link 改动都应据此补/改测,保持「本地一条命令全量绿」。

## 第一性原则
- **被控端 = 单一真相源,控制端 = 纯镜像**。测试要守住:控制端任何状态都能从被控端重新同步出来;丢帧 / 断连 / 重启后能 heal;连接异常对用户可见。
- **确定性优先**:能用纯函数 / 注入依赖测的,就不依赖真实 WS / Electron / React 渲染。桌面端 vitest 是 `node` 环境(无 jsdom),**不引入 RTL**;hook 的编排逻辑一律抽成可注入纯核(engine / 纯函数)再单测 —— 与现有 `deriveRemoteConnectionStatus` / `isControllableDevice` / `mergeCommands` 等同款约定。
- **安全闸门有测试**:allowlist、remoteControlEnabled 门禁、controllerDeviceId 防伪造、workdir guard —— 回归必须显式红。

## 分层与测试手段

| 层 | 源 | 测试手段 | 关键不变式 |
|---|---|---|---|
| relay 服务端 | `apps/server/src/device-link/*` + `routes/deviceLink.ts` | 真 `ws` server + 假 client(`apps/server/src/__tests__/deviceLink.test.ts`) | hello 握手 / 版本不匹配 4400 / 重复设备 4409 / Bearer 鉴权 / 按 dst 路由 / CONTROL_KINDS 门禁 remoteControlEnabled / push 不门禁 / 超大帧 PAYLOAD_TOO_LARGE / 断线 presence-offline 广播 / 跨账号隔离 |
| 协议/客户端包 | `packages/device-link/src/{client,allowlist,topics,protocol}.ts` | 纯单测 + 假 `WsLike`/timing 注入(`__tests__/client.test.ts` 等) | 指数退避重连 + epoch 丢弃过期 socket 回调 / 心跳 pong-miss 强制重连 / 请求按 id 配对 + 超时 / 断线 fail-all-pending / 离线时 send 静默忽略 / 版本不匹配保持离线 / allowlist 默认拒绝 + 危险模式不变式 / topicForPush 路由 |
| 桌面 main | `apps/desktop/src/main/device-link/*` + `localDb/ipc/sessions.ts` | 假 client + 内存 registry + mock drizzle/electron(`__tests__/deviceLink*.test.ts`) | invoke 双层门禁(remoteControlEnabled + allowlist)+ CHANNEL_NOT_ALLOWED / 订阅控制帧用 server 填的 src 作 controllerDeviceId(防伪造)/ topic fan-out 只发订阅者 / set-* 回流 persistSessionFields + 广播 / presence-offline 清僵尸订阅 / remote-workdir-guard 失败 fail-safe / 错误经隧道 `[CODE]` 透传 |
| 桌面 renderer | `features/device-link/*`、`lib/{makerTransport,makerChatStore}.ts`、`features/cc-agent/hooks/useRemoteSession*`、`hooks/useControllableDevices` | 纯核单测 + 模块级 store 直驱 + 源不变式(`__tests__/*.test.ts`) | 按 sessionId 来源路由(本机 vs 隧道)/ remoteProjectsStore applyPatch(删/归档移除、未知 reseed)+ epoch 乱序保护 + 引用稳定 / 启动竞速 origin 对账 / **消息对账 heal(reconcileRemoteMessages)** / 重 topic 随重连重建 + 多触发源去抖 / 连接状态派生 + banner / 本机会话零回归 |
| **跨层真·端到端** | 真 relay(`apps/server`)× **两个真实 `DeviceLinkClient`**(host + controller) | 真 http + `initDeviceLink` + ioredis-mock + 真 JWT,node `ws` 适配器注入 `createWebSocket`,收紧 timing(`apps/server/src/__tests__/deviceLinkClientRelayE2E.test.ts`) | 真客户端 hello 握手 → presence 感知 / 真实 `client.invoke` 往返 / 在线 push 投递 / **断连(socket terminate)→ 真实指数退避重连 → 以被控端为准重新 invoke 拉全量 heal(断连期丢失内容补回、丢失 push 不补发)** / REMOTE_DISABLED / DEVICE_OFFLINE reject / **server↔package 两份 protocol PROTOCOL_VERSION wire-compat parity** |

## 本地全量跑
```bash
# 桌面端(main + renderer + package via workspace)
pnpm --filter desktop exec vitest run            # 或仅 device-link 相关:见下
pnpm --filter @cindy/device-link exec vitest run
cd apps/server && pnpm test                       # relay 服务端 + 跨层真·端到端 E2E
```
> 跨层 E2E(`deviceLinkClientRelayE2E.test.ts`)在 `apps/server` 下跑——它同时需要真 relay 与真 `@cindy/device-link` 客户端,故把 package 作为 server 的 **test-only devDependency**(`workspace:*`)引入,不构成运行期耦合。
device-link 子集(快速回归)按文件名前缀:`deviceLink* / remote* / reconcile* / fastModeMirror* / vendorAuthGate* / controllableDevice* / agentCapabilitiesDeviceCache / modelDefinitionsDeviceId / slashCommandsDeviceId / fsBrowse / touchUserSendBroadcast / projectGrouping / sidebar* / newMakerProjectPicker / client / allowlist / topics`。

## 静态完整性闸门(免人肉逐语言点界面)
- **i18n**:`apps/desktop/src/renderer/__tests__/i18nCompleteness.test.ts` 扫描 renderer 全部静态 `t('a.b')`,复数感知 + 跳过带内联默认值的 key,断言每个 key 在 4 语言 `common.json` 全齐。`fallbackLng='en'` 会让漏翻静默回退、连 en 都缺则渲染裸 key——这类只能靠对应语言用户撞见的遗漏,现在 CI 直接红(device-link 这轮就靠它补回了 9 个漏掉的 key)。新加 UI 文案后无需再人肉逐语言核对。`KNOWN_MISSING` 是与 device-link 无关的既有债务名单,修一条删一条;第二个用例防名单腐化。

## 手测台账(每个用户场景 → 自动覆盖 → 残留人测)
目标:把「要两台真机手测」的面压到只剩**真 GUI 渲染 / 真 agent 进程 / 真网络抖动手感**——一切逻辑 / 数据 / 接线都自动化。改动 device-link 后对照本表确认覆盖没退化。

| 用户场景 | 自动覆盖(测试) | 残留人测 |
|---|---|---|
| 控制端打开远程会话看见被控端历史 | Tier1 `deviceLinkControllerScenarios` + `reconcileRemoteMessages` / `remoteHistoryOriginReconcile` | 仅真机 GUI 渲染 |
| 被控端实时消息流到控制端(live push) | Tier1(`messages:created` push → 追加) | 真 agent 流式视觉 |
| 丢消息→重连/turn结束→以被控端为准 heal | Tier1(丢帧+reconcile)+ 传输层 E2E(真客户端真重连)+ `remoteSessionSyncEngine` | 真网络抖动手感 |
| 新建远程会话出现在正确项目下(双端一致) | Tier1(create 隧道+出现在设备列表)+ Tier2(create dispatch+guard) | 被控端真 agent 真起进程 |
| 添加远程项目:浏览/新建目录并建会话(Bug1) | **Tier2 端到端**(真 guard+真内存DB+真 fs)+ `fsBrowse` / `remoteBrowseAdapters` | 真机文件浏览 UI |
| 新建会话「缺 API」读被控端而非控制端 | `vendorAuthGateRemoteReadiness`(纯核)+ Tier1 invoke 路径 | 真机弹窗呈现 |
| 连接状态 banner(reconnecting/host-offline) | `remoteConnectionStatus`(派生)+ `remoteSessionSyncEngine` | 真断连触发的视觉 |
| 被控开关/allowlist/防伪造 src | 服务端 relay E2E + **Tier2 双层门禁** | 已全自动 |
| 设置变更(set-model 等)双端一致 | Tier1(`sessions:patched` 镜像)+ Tier2(set-* 回流持久化) | 真机视觉 |
| WS 重连 / 心跳 / 指数退避 | 传输层真客户端×真 relay E2E + `client.test` | 已全自动 |
| UI 文案 4 语言齐全 | `i18nCompleteness` 静态闸门 | 已全自动 |
| 远程控制设置页渲染 | (node 环境不引 RTL,无渲染测试) | 真机看 UI |

## 覆盖契约(改动时必须同步)
- 改 `client.ts` 状态机 → 补/改 `client.test.ts`(用注入 timing 控制重连/心跳,不睡真实时间)。
- 改 allowlist channel → `allowlist.test.ts` 既有「危险模式不变式」会自动挡误加;新增正向断言。
- 改 relay 路由/门禁 → `deviceLink.test.ts`。
- 改控制端镜像/对账/hook 编排 → 对应 renderer 纯核单测 + 源不变式(锁住接线不退化)。
- hook 不写 RTL:把触发/去抖/订阅编排抽成 `create*Engine(deps)` 注入式纯核单测;hook 仅作薄 adapter,源不变式锁住「hook 用了该 engine」。

## 已知非目标(本地测不了的)
- 真实多 relay 实例 + Redis 的跨实例 presence/route 竞态(软状态,生产 eventual-consistency,不在本地单测范围)。
- 断连重连 / 丢帧后 heal 的**传输层**逻辑已由跨层真·端到端 E2E(真 relay × 两个真实客户端,真实 terminate + 退避重连)覆盖,不再只靠假 client 模拟。仍**不**覆盖的是真实 Electron GUI 双机 + 真实 LLM agent 的端到端(无 GUI E2E 基建;真实 agent 输出不确定,需 GUI 自动化另起一套,ROI 低,暂列目标外)。
