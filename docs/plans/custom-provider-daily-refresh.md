# 自定义供应商模型列表：24 小时自动刷新方案

- 日期：2026-11-03。状态：已按用户后续决定实现后台调度，正在执行本地门禁；尚未进行人工验收。
- 核查基线：`38c932bdbe35b5e01f15d47a08b6840708417b5b`。
- 用户目标：Cindy 运行期间，自定义连接每隔 24 小时后台查询模型；持久化查询时间，手动刷新后重置间隔。启动和电脑唤醒时补查已到期连接，不依赖打开页面。
- 最小改动原则：复用网络发现、模型合并、现有保存队列、账号隔离及原子文件存储；补调度、查询时间记录，以及防止手动／自动刷新相互覆盖的必要保存适配。本文不改变现行产品／工程规则。

## 1. 行为约定

| 场景 | 处理 |
| --- | --- |
| App 启动、账号初始化或电脑唤醒 | 检查本机当前账号的自定义连接，逐个判断是否到期 |
| 没有查询记录，或距上次尝试已满 24 小时 | 后台查询一次该连接已配置且可发现的 runtime |
| 不满 24 小时 | 不发起自动查询 |
| App 持续运行 | Main 定时检查，到期刷新；本地检查最多间隔一小时，不代表每小时请求供应商 |
| App 退出或电脑休眠 | 不执行，也不唤醒电脑；恢复运行后补查到期连接 |
| 查询成功 | 合并新型号及接口实报资料；不删除本次未返回的旧型号 |
| 查询失败或部分 runtime 失败 | 保留原配置；成功部分按原合并规则处理，失败部分不清空 |
| 查询开始后连续进出页面、重启 App | 查询时间已持久化，不因此再发一轮 |
| 用户点手动刷新 | 随时可查；不受 24 小时限制，实际尝试启动时重置 24 小时间隔，成功失败都计算；保留现有提示和交互 |

“上次查询”具体指**上次查询尝试启动时的时间**，成功与失败均计算；全部在预检查中被跳过、未启动查询时不计算。自动刷新以连接为单位，在首个可查询 runtime 启动前认领一次冷却并记录时间，随后才访问网络；这次认领覆盖本轮该连接的其他可查询 runtime，不能被本轮刚写入的时间挡住。手动刷新已保存连接时也更新时间，避免刚手动查完又自动查询；手动查询不检查冷却，也不因更新时间终止已认领的自动轮后续 runtime。

自动刷新只查询目录，不发送聊天消息、试听或模型生成请求。不弹成功／失败 toast，不阻塞页面显示。

**可见性保持当前代码语义。** 本基线的手动合并使用原生引擎默认及用户 override，并非一律隐藏新型号；本次不新增“全部隐藏”规则。此前讨论中的“新型号默认隐藏”不应作为现状或隐含改动。

## 2. 已有链路与复用点

| 职责 | 当前实现 | 本次处理 |
| --- | --- | --- |
| 页面进入通知 | [ProvidersSection.tsx](../../apps/desktop/src/renderer/components/settings/ProvidersSection.tsx) 已发送 `requestProviderModelsAutoRefresh('providers-open')` | 保留内置刷新行为；自定义连接另由 Main 生命周期调度，不加页面 effect |
| IPC 校验 | [providerHandlers.ts](../../apps/desktop/src/main/maker-ipc/providerHandlers.ts) 的 `PROVIDER_MODELS_AUTO_REFRESH` 已校验可信调用方及 trigger | 内置自动提示保留原 channel、参数和返回结构；既有查询／保存通道仅补发现增量所需的可选字段 |
| 内置自动刷新 | [provider-model-auto-refresh.ts](../../apps/desktop/src/main/maker-host/provider-model-auto-refresh.ts) 管理内置四家的触发、冷却及在途请求 | 保持既有行为，不将内置 30 分钟／失败 5 分钟策略推广给自定义连接 |
| 依赖装配 | [register.ts](../../apps/desktop/src/main/maker-ipc/register.ts) 注入 `requestModelsAutoRefresh` 和 `fetchModels` | 装配时间文件、启动定时器及唤醒／账号失效通知；提交衔接留在现有 handler 层，复用其保存队列 |
| 网络发现 | [provider-model-fetch.ts](../../apps/desktop/src/main/maker-host/provider-model-fetch.ts) 的 `fetchProviderModels`、`fetchSavedOAuthProviderModels` | 复用端点推导、鉴权、代理、超时、分页、响应解析和 OAuth 所属检查 |
| 模型合并 | [customProviders.ts](../../apps/desktop/src/renderer/lib/customProviders.ts) 的 `appendDiscoveredCustomProviderModels`，底层为 `mergeDiscoveredRuntimeModels` | 仅将需要两端共用的纯合并函数移至 Desktop shared，保留原导出和调用方式 |
| 配置保存 | `providerHandlers.ts` 的 `withProviderConfigMutation`、`updateProviderFromInput`、`resolveLatest`；底层为 [custom-provider-store.ts](../../apps/desktop/src/main/maker-host/custom-provider-store.ts) | 手动／自动发现经同一保存层合并最新配置，保留路由变更与 Codex Host 保护；不在新模块直接写库 |
| 连接／凭证失效判断 | [provider-route.ts](../../apps/desktop/src/main/maker-host/provider-route.ts) 的 `getProviderRouteCredentialRevision`、`isProviderRouteMutationInProgress` | 复用现有进程内代次；换 Key、换绑定、删除重建后旧结果失效，不新增数据库代次字段 |
| 列表更新 | `refreshCustomProvidersIntoCatalog` 与现有目录变化通知 | 仅有效配置变化后刷新；不另造推送事件 |
| 文件存储 | [appSessionState.ts](../../apps/desktop/src/main/appSessionState.ts) 的 `ownerScopedUserDataPath` 和 [override-settings-file.ts](../../apps/desktop/src/main/maker-host/override-settings-file.ts) | 复用账号目录、原子更新、文件锁及账号代次检查 |

## 3. 最小实现方式

在 Main 增加一个小模块 `custom-provider-model-refresh.ts`，集中放本功能的时间记录、自动调度与已保存连接查询协调。不另建通用任务系统、持久队列或一套新的供应商服务。

1. 在 register.ts 中启动 Main 自定义刷新模块，监听电脑唤醒和账号失效，在退出时停止。到期才查询，成功失败均计算 24 小时间隔。账号边界未就绪时延后本地检查；保持现有内置供应商的页面／前台刷新行为。
2. 新模块在 Main 持有一个绑定账号 scope 的整轮 `autoPass` Promise；同一 scope 的后续调度通知直接加入当前轮，不新起遍历。该轮内连接和 runtime 都顺序处理。每个连接开始时检查账号、连接及冷却，在首个可查询 runtime 启动前原子认领一次；本轮内的后续 runtime 只重查账号、连接、路由和凭证有效性，**不再判断或重新认领连接冷却**。单个 runtime 的接口失败不阻止其余仍有效的 runtime；连接／凭证代次失效则停止该连接旧轮。不能仅靠每轮内部的 `for/await` 声称多窗口全局串行。切账号后旧轮停止发起后续请求；旧轮的 `finally` 只能清理自己的句柄，不能清掉新 scope 的轮次。
3. 自动和手动的已保存连接刷新都由 Main 在同一捕获过程读取当前路由、Key／headers、账号代次和 `getProviderRouteCredentialRevision`，不使用 Renderer 提前读出的 Key。存在配置 mutation 时不拼接路由与凭证发请求；任何 await 后以及真正发请求前重新验证捕获仍有效，失效则放弃，不将旧凭证重新标记为新代次。OAuth 复用现有发现函数和所属检查。每次后续分页请求及最终保存前都检查所属和凭证代次。
4. 自动与手动的已保存连接查询可以共用**参数一致**的在途请求，匹配项包含账号 scope、实际连接 ID、runtime、路由／协议身份及凭证代次；未保存表单或使用不同临时参数的请求不共用。手动不受冷却限制。该去重只减少网络请求，不能代替保存阶段的协调。
5. 同一连接本轮先收集各 runtime 的发现结果，结束后将成功部分一次性作为增量送入现有 `withProviderConfigMutation` 队列，避免边查边保存使本轮后续 runtime 的代次被自己改变。手动和自动都在队列内读取最新配置，再通过现有 updateProviderFromInput 内的发现增量分支合并。不得由 Renderer 的旧完整配置覆盖当前配置，也不得由自动模块绕过该队列直接调用数据库更新。沿用参数校验、所属检查、路由 mutation、Codex 配置签名比较、Host 变更保护及 `afterChange`；网络查询不占用保存队列。
6. 增量合并无变化时不写库、不更新路由代次、不重复广播；有变化时完成原保存流程后刷新目录并通知。自动入口在保存层提供 Main-only 的“不得中断任务／不得自动确认”策略：若当前更新需要干预忙碌任务，在准备或重启 Host 之前就返回未应用，保留旧配置。不能简单省略 `source: 'manual-settings'`，因为现有保护并不保证这样会跳过重启。

### 3.1 手动与自动共用保存层

现有手动按钮仍负责显示反馈、必要确认和语音参考型号补充。必要的变化仅是：收集成功 runtime 的原始发现结果及对应 Main 查询快照，以增量提交；不再把页面读取时的整份模型配置作为刷新保存的真相源。

- 沿用 `PROVIDER_MODELS_FETCH` 和 `PROVIDER_CUSTOM_UPDATE`；在已保存连接的查询响应中追加可选、无秘密的发现快照，在保存 options 中追加可选的发现增量。快照绑定实际连接、账号代次、runtime、路由身份和凭证代次；增量携带成功 runtime 的 `DiscoveredModel[]`。具体类型集中在 Desktop shared，由 Main 校验，字段不是授权凭证。
- `PROVIDER_CUSTOM_UPDATE` 的发现分支只使用连接 ID、发现增量及其上下文；不从旧完整 config 接受名称、路由、鉴权或用户字段覆盖。发现分支不接受同时改 Key／headers，也不和创建、导入或普通编辑混用。
- 排队结束后重新检查快照所属、实际路由及凭证代次；不匹配就拒绝旧结果，不重新请求。检查通过后，在现有保存核心读取的最新模型列表上合并；保留另一轮已新增的型号和最新用户显式字段。两次保存的先后顺序不能导致旧列表覆盖新列表。
- 自动分支在 Main 内直接传同一种增量给保存 helper，不伪造 Renderer event，也不调用 IPC 模拟用户。只在现有 handler 内整理共用的保存核心，可信 sender 校验留在外部 IPC 入口。
- 若前一次保存已提交并改变了路由代次，后一次仍须拒绝旧快照，不能为了“共用过请求”绕过检查或重放确认；手动用现有错误反馈说明需要重查，自动静默丢弃。
- 自动保存**不传入**手动专用的 `speechReferenceRefreshAgents`，不新增语音参考型号。旧调用方未提供增量时保持原普通编辑／保存行为；新增可选字段不改变其他现有调用者。

数据库层的 `updateCustomProviderIfUnchanged` 只能是共用保存层内部按需使用的额外保护，不能单独代替 mutation 队列和 Host 保护。无需为本功能改写数据库 store 或所有编辑／导入流程。

### 3.2 已保存查询的凭证与快照绑定

现有手动刷新先在 Renderer 调用 `readCustomProviderKey`，再把 Key 传给 Main；新方案必须改变这一处调用方式，不能只给原返回值补一个“当前代次”。

- 在既有查询参数中增加显式、可选的“已保存连接刷新”分支，输入以连接 ID 和 runtime 为定位依据。新版手动刷新进入该分支，不再先读 Key；自动刷新在 Main 内使用同一已保存查询入口。Main 不采用请求中的旧 Key、鉴权 headers、地址或协议来构造该分支的实际请求，而是从当前连接及凭证存储重建。
- Main 先捕获账号 scope 和凭证代次，确认无进行中的路由 mutation，再读取匹配的路由、鉴权方式和凭证；读取后复查 scope／代次及 mutation 状态，只有一致的捕获才可发请求。若经过冷却文件锁、OAuth 准备等异步等待，发送前及等待期间需要的新请求也必须复查。不能在读取旧 Key 后，仅重新读取代次并给旧 Key 贴上新代次。
- 实际 HTTP 请求与查询结果快照共用这次捕获；快照中的代次不是响应回来后新读的当前值。在途去重键也由该捕获产生；凭证变更后不加入旧代次请求，不把旧结果作为新账号／新凭证的发现增量保存。
- 临时表单查询保持原输入语义，使用用户本次输入的端点、Key 或 headers，独立执行；即使其携带旧式 `savedProviderId` 用于现有表单行为，也不能仅凭该 ID 生成已保存刷新快照或加入已保存刷新请求。仍受原端点与密文头安全校验约束，不新增读取或外发已存凭证的出口。
- 旧调用方未显式选择新分支时，保留原查询返回与处理；不能因为带有 `savedProviderId` 就把 Renderer 传来的临时／旧 Key 标成当前 Main 凭证。新旧路径的区别由显式输入语义判断，不通过 Key 的真假、是否为空或是否缺省来猜测。

参与范围由当前真实连接决定：普通 API Key、通用 OAuth 及既有合法本地免鉴权端点可参与；跳过已停用、无有效路由、无法取得所需凭证的连接。`auth.native` 订阅账号、受托管的本地模型服务、组织管理、分享收到或另一台电脑的连接不进入通用自定义分支，继续使用其原有发现责任侧。不能只凭 `source === 'user'` 就全部拉取。

## 4. 查询时间存储

新增一个 Main 管理的轻量文件，路径由现有 helper 生成：

```text
ownerScopedUserDataPath('model-discovery', 'custom-provider-refresh.json')

<userData>/owners/<账号存储键>/model-discovery/custom-provider-refresh.json
```

最小数据结构：

```json
{
  "version": 1,
  "providers": {
    "example-provider-id": { "lastAttemptAt": 1793664000000 }
  }
}
```

- 以实际保存的连接 ID 为键，不用名称或品牌；重命名不重置时间。每条连接保存一个时间，不存 runtime 发现结果的第二份副本。
- 只保存 ID 和时间，不存地址、Key、headers、Token 或用户内容。时间必须是有效时间戳；时钟回拨导致记录落在未来时，仅按到期策略处理一次，不永久停止刷新。
- 使用 `createOverrideSettingsFile` 的 `updateAtomic`，在同一锁内以连接为单位判断到期并认领本轮尝试，**每个连接每轮至多认领一次**；认领状态只放在当前执行上下文中，不新增持久 token 或逐 runtime 时间字段。首个 runtime 记录的时间只阻止其他自动轮，不阻止本轮其余 runtime。网络请求不持有文件锁。首次无文件时按无记录处理。
- 同一 App 内以整轮 `autoPass` 合并多窗口检查，查询层另做参数一致的在途复用；两者不是同一层去重。多进程共用同一 profile 时以原子认领避免重复自动启动，不承诺跨进程共用一个网络 Promise。
- 文件损坏保留原文件；复用 `preserveUnreadableFile` 等现有能力。本进程以内存记录维持 24 小时限制，写盘异常不影响现有模型和手动刷新；无法持久化时，重启后可能多查一次，不能声称此时也严格跨重启限频。
- 每轮清理已不存在的连接记录，防止无限累积。不为调度缓存新增连接创建代次或数据库读取字段；若连接删除后在下次检查前以同一 ID 重建，可能沿用剩余冷却时间，用户仍可立即手动刷新。该限频规则不表示旧请求仍有效：在途结果必须另经现有路由／凭证代次检查。

**不需要数据库 schema migration。** 查询时间属于可丢失的调度状态；供应商和型号仍保存在原有数据库配置中，发现新型号时通过现有接口更新。无文件的老用户无需迁移；旧版忽略新增文件，不改变其数据库兼容性。

## 5. 并发、失败与生命周期

| 情况 | 最小保护 |
| --- | --- |
| 多窗口、重复调度 | 同一 scope 共用整轮 `autoPass`，连接级只认领一次冷却；后续 runtime 不重查冷却，旧轮完成不清理新轮句柄 |
| 自动中点击手动刷新 | 参数及代次一致时共用查询；两者增量在同一保存队列内合并最新配置。排队后快照失效则不提交，不以网络复用代替保存协调 |
| Renderer 读过旧 Key 后、手动查询到达 Main 前换 Key | 新已保存刷新分支从 Main 捕获当前凭证与代次；不使用旧 Key，不给旧式／临时查询附上新凭证快照，也不错误加入旧 Key 请求 |
| 供应商编辑、换 Key／鉴权绑定、删除或重新创建 | 请求前、分页前及保存排队后检查账号代次、路由身份和 `getProviderRouteCredentialRevision`；同 ID、同配置重建也拒绝旧代次结果 |
| 切账号、退出登录或 App session 代次变化 | 停止旧队列，不再读取新账号凭证，不写入新账号时间或配置，不广播旧结果 |
| 页面离开 | 已开始的 Main 查询可完成；不依赖组件回调，不因结果返回重新打开页面 |
| 部分失败／超时／不支持列模型 | 保留有效配置，记录本轮尝试；不加自动退避重试和后台补跑 |
| 目录未发生变化 | 不写数据库，不广播重复的配置变化 |

到期判断仅决定何时查，不决定连接权限或可见性。已有停用、鉴权、loopback、同源发现地址、重定向及凭证所属检查均继续生效，不为复用而绕过 IPC 中原有的已保存路由校验。

发现快照组合现有路由／凭证代次和当前 Main 的发现代次，均为进程内计数。仅更新模型资料或另一 runtime 的凭证时只推进发现代次，避免误撤销已有 Codex Host 的冻结路由；实际 Codex 路由变更和删除重建仍由原路由代次保护，无需新增持久状态。请求发起前用 `isProviderRouteMutationInProgress` 避免读到切换中的路由；进入自身保存队列后以 captured revision 比较为准，不把自身持有的 mutation 误判为另一项操作。校验只排除过期结果，不绕过原权限、账号和路由校验。

## 6. 预计代码范围

| 文件 | 必要变化 |
| --- | --- |
| `apps/desktop/src/main/maker-host/custom-provider-model-refresh.ts`（新增） | 时间记录、整轮 `autoPass`、连接级一次认领、已保存查询复用与凭证一致捕获；通过注入回调提交增量，不直接写库 |
| `apps/desktop/src/main/maker-ipc/providerHandlers.ts` | 现有自动 trigger 分派、已保存／表单查询分支校验、发现增量参数校验、队列内 `resolveLatest` 合并、手动／自动共用保存核心及自动不打断策略 |
| `apps/desktop/src/main/maker-ipc/register.ts` | 注入查询、路由／凭证代次及保存层需要的 Main 能力，不另建保存队列 |
| `apps/desktop/src/shared/customProviderUpdate.ts` | 查询快照／发现增量类型及保存 options 的可选字段；兼容原调用方 |
| `apps/desktop/src/main/maker-host/provider-model-fetch.ts`、`apps/desktop/src/preload/preload.ts` | 对齐显式已保存刷新输入和可选快照返回类型；临时表单、网络响应解析及 preload 透传能力保持原边界 |
| `apps/desktop/src/shared/customProviderModelRefresh.ts`（新增） | 从 Renderer 原样提取纯合并函数，包含 OpenRouter 既有兼容处理 |
| `apps/desktop/src/renderer/lib/customProviders.ts` | 引用／转导出提取后的函数，保持已有 API 和调用者 |
| `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx` | 已保存连接手动刷新不再回读 Key，改走 Main 已保存查询分支；收集发现增量／快照并交 Main 合并，保留按钮、提示、确认和语音参考交互 |
| 对应 Main、IPC、纯合并和页面入口既有测试 | 验证新分支及受影响行为，必要时增加 Main 模块测试 |

以上为预计范围，实施时以真实依赖核对。相对初稿，保存并发安全确实需要修改现有 handler、手动刷新提交以及既有 IPC 的可选字段／类型，不能继续承诺这些文件完全不变。仍不新增 IPC channel，不改数据库 schema／migration、共享 package、Mobile、Server、UI 布局、语言文件或内置刷新协调器；路由／凭证代次工具直接引用现有导出，不改其实现。

可选字段仅用于本机可信设置入口，不新增 Device Link／relay 暴露或 allowlist。旧调用方访问新 Main 时仍走原合同且不生成新已保存快照。新查询分支及发现增量由同版本 Desktop 的 Renderer、preload、Main 一起交付；不得把新分支的无快照、失效或错误结果当成旧版支持，退回 Renderer 旧 Key 再请求或用旧完整配置保存。缺少新分支的旧版保留其原手动流程，但不宣称具备本方案的新并发保证。自动调度和保存 helper 均由同一个 Main 版本装配，不依赖旧端具备新能力。

实现包含 Main 调度与存储、保存队列的增量合并、手动刷新 IPC 适配及定向测试。未操作正式用户配置；网络和时钟测试使用假数据与临时目录。人工及真实供应商验收尚未执行。

## 7. 验证计划

实现时控制时钟、账号代次、网络及临时存储，经真实触发入口验证：

1. 启动即检查、24 小时内不触发、恰满 24 小时由定时器再触发；唤醒补查，退出取消；不依赖页面通知。
2. 多个调度同时到来且有多个到期连接时，只启动一个自动遍历，轮内不会分别查不同连接造成并发；重复检查不追加轮次。重建服务并读取同一文件后仍限频；成功、失败及部分失败都记录尝试。
3. 手动始终可查，手动查后自动不重复；相同参数及凭证代次的在途查询共用，不同 runtime、路由、代次或临时表单参数不会误合并。分别控制“手动先保存／自动先保存”，确认保存层合并最新配置或拒绝已失效快照，不会用旧完整配置覆盖新型号或用户字段。
4. 新型号和接口资料正确合并，保留用户显式字段和显示 override；无返回的旧型号不删；OpenRouter 兼容保持，自动不补语音参考型号。
5. API Key、仅 headers、通用 OAuth、合法 loopback 路径按原边界工作；原生订阅、已停用、远程／分享／托管连接不被误查。
6. 请求期间编辑、仅换 Key／headers、换鉴权绑定、删除、以相同 ID／配置重建或切账号时，旧结果不回写；保存队列等待期间换代次也拒绝，分页前失效不再发下一页。验证旧自动轮结束不会清掉新 scope 的在途句柄。
7. 经现有 mutation 保存入口测试路由保护与 Codex 签名比较；自动刷新遇忙碌任务且需 Host 变更时，在任何 prepare／重启之前跳过；手动确认仍有效。重复合并无变化时不写库、不改变路由代次、不通知。
8. 缓存缺失、损坏、写入失败、时钟回拨及连接记录清理均有定向覆盖；测试只使用临时目录和假凭证。旧查询／保存参数仍被接受且不生成已保存快照；新已保存分支缺少快照时不退回旧 Key 查询或旧整份配置保存。非法或跨账号／连接的增量不能进入保存。
9. 一个连接同时配置 `claude-code`、`codex`、`pi` 三个可查询 runtime：断言仅发生一次自动冷却认领，但三个 runtime 都被查询；首个 runtime 失败后其余仍被查询，第二次检查则整体被连接冷却挡住。手动中途更新时间不阻止已认领轮的后续 runtime；账号或凭证代次失效仍应停止旧轮。
10. 重现“Renderer 已缓存 Key A → 保存 Key B → 已保存查询到达 Main”：新已保存分支仅使用 Main 当前 Key B 和与其一致的代次，即使请求混有旧 Key A 也不采用它；不向该旧式／临时参数路径附新已保存快照，不把新请求加入 Key A 的在途查询。另测 Main 捕获 Key 后、发请求前换 Key：应放弃旧捕获，不能用旧 Key 配新代次；临时表单仍用显式输入的 Key 且独立查询。

提交实现前按仓库要求运行 `pnpm test:unit:related`、`pnpm --filter desktop run --if-present typecheck` 及差异检查；再按个人流程完成独立审查和验收。通过自动检查不等于人工或真实接口验收通过。

## 8. 负担与不纳入项

日常开销为 Main 定时检查本地小文件和到期判断；只有到期才访问接口。同一 scope 的自动遍历共用整轮 Promise 并串行执行，避免多窗口各起一轮或连接较多时集中并发；用户主动发起的不同手动查询不受此自动串行承诺限制。切账号后旧网络请求可能尚在结束，但不得继续分页、提交或发起下一项。网络请求数取决于连接数、runtime 数及接口分页；一次连接刷新不承诺只有一个 HTTP 请求。请求继续使用现有超时和分页上限，只增加 App 内定时器和唤醒通知，不创建系统常驻任务或模型进程。

型号较多时，解析和合并仍有成本，页面加载不等待这些结果；使用 no-op 检查减少数据库写入和目录重建。这里是实现方案与预期，不是性能实测结论。

不增加自动刷新开关、时间可配置项、成功状态面板、自动重试、跨设备时间同步、连接迁移或目录架构重构。用户仍通过现有手动刷新立即重查。
