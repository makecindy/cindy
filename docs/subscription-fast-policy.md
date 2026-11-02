# 订阅账号与供应商组的 Fast 控制

本文是本次实现的交接说明，包含产品范围、执行路径、代码入口、验证方法和发布边界。

2026-10-23 追加的主审独立 review、五个 Orca DeepSeek 审核及十项修复，见[独立审查与修复记录](subscription-fast-policy-review.md)。

## 1. 交付范围

订阅账号所有者可以在供应商设置或「远程与分享」管理页关闭「允许使用 Fast」。供应商组所在电脑也有独立的同名开关，位于「自动换电脑」下面。

首次升级或登录时，账号与组的「允许使用 Fast」默认开启，不因未分享或开始分享而改变。现有任务的 Fast / Ultrafast 偏好继续生效；登录本身不会替任务开启 Fast。只有用户明确关闭相应开关后，才新增普通速度限制。

| 设置 | 影响范围 |
| --- | --- |
| 订阅账号关闭 Fast | 使用这个实际账号的本机、同账号远程和分享任务 |
| 供应商组关闭 Fast | 经这个组分配的任务，包括组内远程执行与转分享；组所在电脑直接执行的分享任务也必须遵守本机组限制 |
| 两处都允许 | 恢复 Fast 的可用性；不会主动把正在运行的任务切回 Fast |

禁用同时覆盖 Fast 和 Ultrafast。收到旧客户端或旧任务发来的加速设置时，执行电脑按普通模式运行。

第一版提供账号、组两层开关，不提供逐模型开关。不修改通用模型能力的正本，也不把模型的原生支持情况永久改成不支持。

### 范围识别

只识别真实的 OpenAI / Claude 原生订阅授权：`auth.method === 'oauth'`，并符合其原生授权身份。

- 自定义 API 供应商不增加这个开关，不改模型发现、缓存规则或请求载荷。
- 自定义 API 供应商即使名称或 ID 是 `openai`，也不能仅凭名字进入限制范围。
- 不迁移 Claude 原生订阅的凭证，也不把它改为经 Cindy 代理处理授权。
- 不修改服务端仓库、Mobile 原生配置、系统 CLI 配置或正在使用的真实订阅文件。

## 2. 生效语义

有效限制取以下约束的交集：实际订阅账号、任务所属的本地供应商组、执行电脑已经接收的远程组约束。执行电脑以 guest 身份处理分享或中转任务时，它自己对该订阅设置的本地组限制也参与交集，无论该组是否包含本机成员。任一层禁止就使用普通模式。

保存设置后热生效，不需要为了反复开关而重启 Cindy。首次获得此功能仍需要更新应用；组所在电脑和实际执行电脑都需要支持新协议。

已经发给上游的请求正常完成。后续用户发送、工具循环、重试、切模型和续接路径会重新应用限制。Codex 的实际请求出口另有保护，因为原生引擎可能在同一轮工具循环中保留旧的加速档。

同一轮中先禁止、再重新允许，出口仍保持普通档，直到用户明确再次启用 Fast。该状态按当前 owner、任务和实际订阅来源隔离，不会串到其他任务或自定义 API；执行侧的模式变化也同步到本机运行时偏好，避免 bridge 和用量记录继续使用旧档。

Codex 只向根线程同步原生设置，子 Agent 的服务档位由原生引擎继承；不向子线程直接发送 `thread/settings/update`，因为 Multi-Agent V2 会拒绝该操作。[官方子 Agent 配置说明](https://developers.openai.com/codex/subagents)也明确服务档位跟随根会话。HTTP 和 WebSocket 请求出口仍按任务所属的订阅策略强制使用普通档，覆盖原生引擎残留的旧档位。

在已经启用可信 Codex 请求代理的执行电脑上，原生设置同步只做尽力更新；同步失败记录警告，不阻断普通发送，禁止 Fast 的最终保证在请求出口。没有该出口时仍要求原生禁用成功。Claude 等依赖原生设置的路径不改变失败处理。

执行限制无法保证时不能谎报成功：保留限制并重试；组页面显示部分电脑尚未确认设置。此时尚未确认的旧版或离线电脑不能作为已经受控的执行电脑使用。

### 旧版与离线电脑

1. 执行电脑声明 `subscriptionFastPolicy` 能力。
2. 组所在电脑发送带修订号的限制，实际执行电脑持久化并建立执行保护后确认；Codex 的可信请求出口与原生设置同步按上述边界处理。
3. 新分配必须先完成绑定；组禁止 Fast 时，不能把未确认的旧版执行电脑当成成功。
4. 开启自动换电脑时，按既有策略尝试其他可用成员。
5. 每 5 秒检查未确认设置；实际同步失败后，各目标独立按 5、10、20、40、80、160、300 秒退避，之后保持 300 秒上限，到期后由下一次检查发起重试。退避使用进程内单调时钟，成功确认后清除；新策略修订立即尝试，不沿用旧修订或其他账号的退避。策略未变化时跳过写盘与缓存重载，不重建共享的 device-link 连接。
6. 移出成员或删除组时发送更高修订的解除约束；离线电脑保持待确认，恢复连接本身不跳过退避，在下次到期检查时重试，收到解除确认后才移除目标记录。

实现见 [fastPolicyRuntime.ts](../apps/desktop/src/main/provider-group/fastPolicyRuntime.ts) 与 [fastPolicyStore.ts](../apps/desktop/src/main/provider-group/fastPolicyStore.ts)；回归见 [fastPolicyRuntime.test.ts](../apps/desktop/src/main/provider-group/__tests__/fastPolicyRuntime.test.ts) 与 [fastPolicyStore.test.ts](../apps/desktop/src/main/provider-group/__tests__/fastPolicyStore.test.ts)。

已有请求不会因开关设置被强制中止。未确认的旧电脑上，原有加速任务也不能声称已切成普通模式；需要让那台电脑更新并确认。建议按电脑滚动更新后再把待确认状态作为完成标准。

## 3. 分享目录更新

执行限制与目录展示相互独立，目录不是最终授权依据。

- 导出有效模型目录时，受限订阅模型的 `supportsFastMode` 和 `supportsUltrafastMode` 均为 `false`。
- 原始目录和用户自己的模型覆盖保持原样，解除限制后可以恢复能力展示。
- 分享接收方启动时按既有加载流程获取目录；收到受限供应商的目录变更事件后刷新缓存。
- 收到未变化的分享列表时，仅对已经识别为订阅分享、且目录超过 60 秒的缓存补刷新。
- 同区域、跨区域分享都使用已有的 `maker:provider:changed` 推送，不增加服务端接口。
- 推送只针对当前被授权的分享及对应 host，载荷不包含账号凭证、组员名单或真实设备身份。
- 刷新失败继续保留原有目录；实际执行电脑仍按当前策略限制请求。

60 秒是目录过期阈值，不是所有场景的刷新时限。检查由既有分享列表同步触发；空闲时同步可能更慢。即使接收方没有主动更新供应商组，执行侧限制仍生效。

## 4. 数据与安全边界

配置存储使用当前 owner 的数据目录和既有原子写文件设施：

| 文件 | 内容 |
| --- | --- |
| `provider-fast-policy.json` | 实际订阅账号的 Fast override |
| 现有供应商组配置 | 可选 `allowFast`；缺省允许 |
| `provider-group-fast-policy.json` | 已接收来源、修订号、任务绑定、已发送限制及各电脑确认情况 |
| `provider-group-fast-policy.json.bindings/<00..ff>.json` | 按任务 ID 的 SHA-256 前两位分片保存新任务绑定；兼容读取主文件内的旧绑定 |

不新增数据库 migration，不把授权凭证写入这些文件。配置缺失按默认允许；已有文件损坏或不可读时，对订阅限制按禁止处理，并拒绝用默认值覆盖原文件。API 供应商不受此回退影响。

远程消息只携带组、修订号、允许状态和必要的任务绑定信息。它不能携带可执行的策略函数。执行电脑根据已认证的控制方重建实际任务 ID，分享 guest 不能绑定到另一个 guest 或所有者的任务。

同修订号冲突只能收紧限制，不能放宽。跨账号切换期间使用既有 owner guard，旧异步结果不能写入新账号。

任务绑定不按时间或普通关闭淘汰，避免旧任务续聊丢失禁令。永久清退受邀者历史成功后，回收对应绑定并保留修订号墓碑。每个分片保留 4 MiB 的文件保护上限；损坏、不可读或写入失败时禁止放行，不声称存储容量无限。调用方传来的 `groupAssigned` / `relay` 只用于路由和防环，不是跳过执行端本机组限制的授权。

## 5. 代码入口

以下均为仓库相对路径。

| 层 | 文件与职责 |
| --- | --- |
| 订阅身份 | `packages/model-providers/src/provider-identity.ts`：`supportsSubscriptionFastPolicy` |
| 目录投影 | `apps/desktop/src/main/maker-host/subscription-fast-policy.ts`；`provider-service.ts` 与 `createDesktopProviderService.ts` 接入投影 |
| 账号存储 | `apps/desktop/src/main/maker-host/provider-fast-policy-store.ts` |
| 组存储 | `apps/desktop/src/main/provider-group/fastPolicyStore.ts` |
| 分发与确认 | `apps/desktop/src/main/provider-group/fastPolicyRuntime.ts` |
| 组内分配 | `provider-group/remoteHandler.ts`、`remoteRegistration.ts`、`guestRelay.ts`、`maker-ipc/register.ts` |
| 托管执行 | `apps/desktop/src/main/remote-agent/host/runHost.ts`、`service.ts`、`sessionIdentity.ts` |
| 通道协议 | `packages/device-link/src/remoteAgent.ts`：可选能力及 `fast-policy` 操作 |
| 启动与实时约束 | `packages/maker-core/src/maker.ts`、`agents/shared/fast-mode-policy.ts` |
| Codex | `packages/maker-core/src/agents/codex/index.ts`：原生 tier、设置更新及子线程保护 |
| Claude Code | `packages/maker-core/src/agents/claude-code/index.ts` 与 `flag-settings.ts`：最高优先级显式 false、实时设置复核 |
| Pi | `packages/maker-core/src/agents/pi/index.ts`：原生偏好钳制 |
| 请求出口 | `apps/desktop/src/main/maker-host/subscription-fast-request-policy.ts`；接入 `codex-proxy-host.ts`、`codex-text-only-policy.ts`、`anthropic-compat-proxy-host.ts`、`anthropic-responses-bridge-host.ts` |
| 供应商管理命令 | `apps/desktop/src/main/device-link/providerShareRuntime.ts`；共享命令类型与管理白名单在 `apps/desktop/src/shared/` |
| 分享刷新 | `device-link/dispatch.ts`、`index.ts`、`providerShareCrossRegion.ts`、`providerShareGuest.ts`；Renderer 的 `providerShareStore.ts`、`useDeviceProviders.ts` |
| UI | `SubscriptionFastSetting.tsx`，接入 `ProvidersSection.tsx` 和 `ProviderShareManagePage.tsx`；组开关在 `ProviderGroupSection.tsx` |
| 文案 | `apps/desktop/src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko}/common.json` 的 `subscriptionFastPolicy` |

## 6. 维护时必须保留的行为

1. 目录上的「支持 Fast」是展示能力，账号和组的禁止策略是执行约束，不能互相替代。
2. 不能仅过滤接收方的按钮，必须保留执行电脑和请求出口检查。
3. Codex 仅更新 `thread/settings/update` 不足以保护进行中的工具循环，HTTP 和 WebSocket 出口都要保留。
4. 自定义 API 路由保持原决策与请求内容；控制面、token 计数接口也不添加加速字段。
5. Claude 的普通偏好 false 过去表示不写字段。订阅禁止必须显式写 `fastMode: false`，覆盖原生和用户设置。
6. 解除禁止只恢复能力，不主动调用 `setFastMode(true)`。请求出口还必须保留已关闭状态，直到明确重新启用，防止进行中的原生工具循环恢复旧 Fast。
7. 设置保存在组所在电脑仍不等于所有成员已经执行，确认失败必须保持待确认状态。
8. 新配置的默认值必须兼容已有用户；无禁止设置时旧执行电脑仍可照常使用。
9. 分享目录刷新必须保留 owner、设备代次和请求合并保护，不能扩展成通用 API 目录轮询。

## 7. 验证与复现

### 单元与回归

2026-10-26 的 V2 子 Agent 兼容修复验证：

- `CodexAgent.startSession` + 真实 `withFastModePolicy` 经过 V2 子线程登记、完成、再次发送，验证普通消息成功且设置 RPC 只发根线程；另验证原生同步失败时，有代理继续普通发送、无代理仍拒绝。原实现的前两种情况先复现失败，修复后三项通过，未放宽已有断言。
- Core 的完整 Codex 与策略套件 1050 项通过，墙钟 43.30 秒（含收集）；复用已有 1042 项的大文件及其原生协议/生命周期夹具，新三项测试体共约 112 毫秒，未增加模块重置、真实等待或新测试文件。设置通道单独选测 11 项通过，墙钟 3.71 秒。
- Desktop 请求出口与策略 15 项、真实 Windows Codex 0.159.2 + loopback 代理/模拟上游 1 项通过，墙钟合计 11.01 秒；原生用例实际执行而非跳过，只用临时 HOME 和合成凭证。V2 拒绝响应由进程内假上游复现，未宣称双机或真实付费子 Agent 已实测。
- Desktop 全量 typecheck、test hygiene（原基线内 361 文件）、文档合同 10 项与 diff 检查通过。
- 完成五轮独立复查，并由五个 Orca DS Worker 分别审查原生协议、HTTP/WS 出口与信任边界、并发和生命周期、范围兼容、测试有效性；五侧均未发现必须修缺陷。协议侧首次异常终止未计作通过，同一 Worker 重试后形成结论。没有用禁用子 Agent、跳过登记或弱化断言规避错误。
- 最终 rebase 到上游 `8cc032d9`，无冲突且 range-diff 确认修复内容等价；随后 Core 三文件 1104 项通过（37.70 秒），Desktop 三文件 16 项通过（10.65 秒），包括真实二进制的 loopback 用例。原 Codex 测试文件单独运行 1045 项通过（30.31 秒）。未完成真实 V2 子 Agent、macOS、不同物理电脑或无代理旧 V1 继承实测；这些边界仍如实保留。
- Core 独立 build 仍有三条上游 `TS2339`：`recipe-loader.ts:205,227` 的 `ImportMeta.glob` 与 `pi-native-auto-compact.test.ts:764` 的 `modelOverrides`。用编译器内存覆盖将两个改动文件还原为上游 `a7e1b800` 后重跑，诊断逐条相同；没有修改工作区文件或类型配置来绕过它们。ESLint 同样与上游逐诊断对照：生产文件 4 条、既有测试文件 33 条，均无新增。

以下为本次执行过的主要批次；批次有重叠，不应简单相加为独立用例数。

| 批次 | 结果 |
| --- | --- |
| 组、分享 Renderer、目录缓存、分发、策略存储与投影 | 45 个文件，933 项通过 |
| Codex、Claude Code 全目录、Pi 路由、通用运行时约束 | 2146 项通过，2 项按环境跳过 |
| Claude 显式 false、回退重建与通用运行时约束补测 | 80 项通过 |
| 请求出口、自定义 API、远程通道与托管回归 | 902 项通过；另 1 项原有 Claude 托管用例遇到 `EBUSY`，见下文 |
| 协议鉴权、组、分享、目录及请求出口的后续定向回归 | 39 个文件，1235 项通过；异步压缩请求与连续开关另有补测 |
| 最终出口、组分发与 API 兼容回归 | 7 个文件，411 项通过 |
| 管理命令、账号切换及禁止解除状态补测 | 2 个文件，83 项通过 |
| Pi 原生转发与解压期间的模式、账号切换补测 | 43 项通过 |
| Maker 本机与托管启动、续接、Claude 重建及模式回读补测 | 5 个文件，229 项通过 |
| Windows 实机发现的本机目录通知回归 | 2 个文件，135 项通过；新增用例在修复前均复现失败 |
| Desktop 全量类型检查、新增模块 ESLint | 通过；最终类型检查在功能代码固定后执行 |
| model-providers / device-link 构建 | 通过 |
| 真实 Codex + 真实本地代理 + 模拟上游 | 通过；见原生验证 |
| Light / Dark、默认 / 禁止 / 待确认 / 320 px 窄屏 | 8/8 通过，包含两个开关来回切换及边界位置断言 |
| i18n key 与术语 | 五种语言对齐，无新增术语违规；保留仓库已有告警 |

UI 证据位于 `artifacts/ui-check/subscription-fast-FsIswe/`：`summary.json` 记录逐项结果，`overview.png` 与各场景目录保存截图。已查看 320 px 窄屏的 Light / Dark 成品；自动化还验证了开关往返操作及布局边界。

主要命令：

```sh
pnpm --filter desktop run typecheck
pnpm --filter @cindy/model-providers run build
pnpm --filter @cindy/device-link run build
pnpm check:i18n
pnpm check:i18n-glossary
pnpm ui:check --page subscription-fast --case all --theme all --locale zh-CN --engine chromium
```

策略测试分别位于 `provider-group/__tests__/fastPolicy{Store,Runtime}.test.ts`、`maker-host/__tests__/subscription-fast-policy.test.ts`、`subscriptionFastRequestPolicy.test.ts` 和 Core 的 `agents/shared/__tests__/fast-mode-policy.test.ts`。

管理命令的真实入口用例在 `device-link/__tests__/providerShareManagement.test.ts`；解压期间解除禁止或切换账号的用例在 `maker-host/__tests__/piNativeSubscriptionForwarding.test.ts`。已进入普通档处理的请求不会因解压期间放开策略而发送空载荷或旧 Fast；账号发生变化则在实际 fetch 前拒绝发送。

Maker 的本机和托管启动都使用已关闭状态过滤旧启动参数；Claude 的 Query 重建继续显式覆盖原生 `fastMode`，模式回读也必须与实际普通档一致。这部分用例在 `packages/maker-core/src/maker.agentDevice.test.ts` 和 `agents/claude-code/__tests__/rewind-runtime-settings.test.ts`。

### 原生验证

`apps/desktop/src/main/maker-host/__tests__/subscriptionFastPolicy.native.test.ts` 使用显式指定的 Codex 二进制、临时 HOME / CODEX_HOME、合成凭证、本地代理和 loopback 模拟上游，不读取真实账号。

```sh
CINDY_TEST_CODEX_BINARY=/absolute/path/to/codex pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/subscriptionFastPolicy.native.test.ts --maxWorkers=1
```

本次使用 Windows 原生 Codex 0.159.2。正向对照先确认真实请求含 `service_tier: priority`，随后在当前响应尚未完成时禁用，再让引擎执行工具并继续同一轮；下一次实际出站请求必须为普通档。同一轮下一次工具调用期间解除限制，继续保持普通档；还覆盖旧任务再次请求 Ultrafast，以及用户明确重新开启 Fast 后实际请求恢复 `priority`。

这项验证实际发现并促成了出口保护：原生设置更新成功，并不代表当前一轮工具循环不再沿用 Fast。

### Windows 真实 Desktop 补充验证（2026-10-22）

在用户这台 Windows 上运行隔离沙箱 `fast-policy-test`（Global、被动调度），通过独立 CDP 端口 `9337` 操作完整 Electron 应用。测试复用 OpenAI 登录态，不修改订阅凭证，不更新或重启正在提供服务的安装版。

真实 UI + Main IPC、持久设置和目录缓存的六项检查通过：账号禁止刷新后仍保留、重新允许恢复可用能力、组禁止覆盖账号允许、组禁止在 Dark 模式刷新后仍保留、账号禁止覆盖组允许，以及清理本次测试组后账号仍禁用 Fast。明暗截图已目检；不只检查 Main 返回值，还检查 Renderer 缓存无需手动刷新即可更新。测试组只有本机成员，没有添加真实远程供应电脑。

这次实机操作发现并修复了本机目录通知遗漏：未登录 Cindy 账号时，分享运行时尚未启动，原来的通知函数没有本机接收者；组变化也仅通知远端。现在订阅策略变化始终通知本机窗口，组通知只对适用的订阅增加目录刷新。回归位于 `providerShareManagement.test.ts` 和 `provider-group/__tests__/ipc.test.ts`。

证据位于 `artifacts/fast-desktop-live/`，包括 `live-results.json`、`group-disabled-light.png`、`group-disabled-dark.png` 和 `supplier-disabled-group-allowed-dark.png`。过程中的定位脚本曾因建组后入口改名而超时，修正定位后完整重跑；最终结果也包含缓存自动更新断言。

需要如实区分的限制和用量：

- 安全启动包装两次返回 `STARTUP_TIMEOUT`（120 秒）；之后实际窗口完成加载并可交互。此处记录的是随后完成的窗口测试，启动门禁不算通过，没有通过修改启动门禁掩盖超时。
- 沙箱未登录 Cindy 云端账号，因此未完成实体多机分享下发、执行端确认或接收方刷新验收；本机组显示待确认符合这一测试环境。相关场景目前仍由自动化夹具覆盖。
- 首次进入沙箱会自动生成伙伴欢迎语，实际产生约 11.3k token 用量；日志记录 `fastMode: false`。没有手动发送付费模型测试消息，也没有用真实账号发送 Fast 请求；前述模拟上游原生验证仍使用合成凭证。

### 同机多实例分享验收准备（2026-10-22）

真实跨账号分享不要求两台物理电脑。两个隔离 Desktop dev 使用不同的 Cindy 登录态、认证设备身份、数据库和 CDP 端口，即可走真实分享服务与 device-link；不能把同机两端替代测试描述成已经覆盖 macOS 或真实跨网断连。组所在实例与执行实例需要分开验收时，可再增加第三个独立 dev。

本仓启动器一个 checkout 同时只保留一个隔离 dev，换沙箱名再次 restart 仍会替换同 checkout 的旧实例。因此接收端使用额外的独立测试 checkout，复制当前未提交功能源码并逐文件核对，不复制用户数据、凭证或其它 checkout 的 `node_modules`。独立运行 `pnpm install --frozen-lockfile --prefer-offline --prod=false` 后，按安全包装启动：

```powershell
# 当前功能 checkout：供应端，复用此前的本机测试沙箱
$env:XDT_CDP_PORT='9337'
pnpm restart:desktop:remote --region=global --isolated=fast-policy-test --passive

# 独立测试 checkout：接收端。--isolated-auth 避免自动复用本机 OpenAI 凭证
$env:XDT_CDP_PORT='9338'
pnpm restart:desktop:remote --region=global --isolated=fast-policy-guest --isolated-auth --passive
```

两个登录页均已实际加载并截图，认证状态回读确认两个不同的 `dev-fast-policy-*` 设备身份；`get-device-id` 返回物理机指纹，不能用它证明认证设备身份隔离。证据位于 `artifacts/fast-desktop-live/peer-status.json`、`peer-login-0.png` 和 `peer-login-1.png`。正式版原进程仍在运行，没有重启。

准备过程中快照校验遇到 CRLF 与 Windows 路径表示差异，已改为规范化路径并逐文件复制、核对源码字节。两次安全启动包装仍返回 `STARTUP_TIMEOUT`，实际登录页随后完成加载；不计为启动门禁通过。此时尚未登录两个不同的 Cindy 账号，因此只完成了双实例隔离与登录页准备，尚未完成真实分享申请、审批、目录下发或请求执行验收。账号登录需要用户在各测试实例界面自行完成，不能复制正式版登录凭证代替。

2026-10-23 登录准备阶段：供应端已由用户登录 Cindy；接收端尚未登录且用户需要手机号入口。登录页按构建区域选择标识方式，Global 显示邮箱、中国大陆版显示手机号，不能通过往邮箱框填写手机号解决。仅将接收端测试 checkout 改为 `--region=cn` 启动（其余隔离参数及 CDP `9338` 不变），保留已登录的 Global 供应端及正式版。构建区域不能直接当作本次分享所属服务区域的证据；下方真实分享响应报告 owner region 为 `cn`，因此不把这次验收记为跨区域服务验证通过。供应端测试账号的 OpenAI / Claude 订阅 Fast 均已关闭，返回目录的 Fast / Ultrafast 能力计数为 0。

手机号入口已实际核验：接收端为 `#/login`、`input[type="tel"]` 可见、无邮箱输入框，登录服务下发 `providers.phone: true`；截图及结果在 `peer-login-phone-cn.png`、`peer-phone-status.json`。已登录供应端与正式版保持原 PID / 启动时间。该次安全启动包装仍返回 `STARTUP_TIMEOUT`（120 秒）；第一次等待手机号输入框 20 秒也超时，随后页面加载完成，重新验证通过，没有重启已登录实例或绕过登录验证。

### 两账号真实分享与订阅请求验收（2026-10-23）

用户完成两端登录后，回读确认两个不同的云端账号及 `dev-fast-policy-*` 认证设备身份。供应端开启测试沙箱的远程调用并生成一次性链接，接收端经真实服务预览和申请；审批在自动化读到待处理快照前已由界面完成，之后按生成的申请编号核验为 approved，未重复创建链接或批准其它申请。链接口令只在测试进程内存中传递，没有写入脚本、输出或结果文件。测试只操作新建分享，不修改供应端原来收到的分享。

真实目录与自动刷新完成以下检查：

1. 授权目录只返回本次分享的 OpenAI，9 个模型，禁止时 Fast / Ultrafast 能力计数为 0。
2. 已缓存的接收端不手工刷新，账号重新允许后 Fast 模型计数变为 8，再禁止后自动变为 0。
3. 账号允许、组禁止时仍为 0；组重新允许后自动恢复；账号禁止也覆盖组允许。
4. 重新加载接收端实际任务页面，由应用自身加载分享目录，仍读到组禁止，输入区没有 Fast / Ultrafast 按钮。设置页尚未选择分享时保留既有按需加载行为；测试不把空缓存当成已经刷新成功。
5. 接收端临时建立仅含该分享的 OpenAI 组，执行端确认组禁止后，`fastPolicyPending` 为 false，组员 available。该组随后解除并确认，未留在用户配置里。

另用原生 Codex 和真实 ChatGPT 订阅完成两条极短请求。两条任务的发起端持久设置均故意保留 `fastMode: 'ultrafast'`；供应端原生日志的 thread/start 和 turn/end 均为 `serviceTier: null`，结束时 `fastMode: false`，收到并保存了 `FAST_POLICY_OK`。

| 请求 | 执行时的限制 | 输入 token | 输出 token |
| --- | --- | ---: | ---: |
| 旧 Ultrafast 设置，经真实分享使用订阅 | 账号禁止，无组 | 18,839 | 7 |
| 旧 Ultrafast 设置，经真实分享使用供应端的组 | 账号允许、组禁止，组内为本机成员 | 18,828 | 7 |

这两条手动验证合计 37,667 个输入 token、14 个输出 token，均为普通模式；不能因为用户提示很短就忽略 Cindy / Agent 上下文本身的 token。前文欢迎语的约 11.3k token 是更早的另一笔用量，不合并成这两条请求。没有用真实订阅做 Fast 正向计费测试；带 priority 的正向对照仍只在模拟上游完成。

本轮测试脚本也修正了几个测试自身的问题：审批已经完成时不再死等 pending；自动刷新断言改为连续读取缓存至稳定，避免把瞬时读数当成最终结果；首条请求的监听器起初读错 `event.data`，通过已保存消息、完成事件和原生日志恢复验收，没有重发该请求。首次创建参数误用 `workspaceKind: scratch` 被拒绝，改为已有的 `project`。尝试从未连接本机 OpenAI 的接收端直接创建本地组任务时，既有模型准入拒绝了该模型，尚未产生模型请求；没有通过改数据库或放宽准入绕过它，也没有把该路径记成通过。实际组请求使用供应端组的本机成员；独立远程执行成员的绑定、离线和多跳限制仍由原有集成夹具覆盖。

证据均在忽略目录 `artifacts/fast-desktop-live/`：`cross-account-share.json`、`share-policy-results.json`、`share-task-results.json`、`group-task-results.json`、`group-live-setup.json`、`recipient-startup-results.json` 和 `recipient-real-task-group-prohibited.png`。原生订阅的证明是执行端实际日志，不能称为抓取了真实上游请求包；HTTP / WebSocket 出口载荷的逐请求断言见前述模拟上游原生验证。

收尾已关闭两条测试任务的运行时，保留消息和工作目录；删除仅由测试建立的组并发送解除约束；供应端 Fast 恢复为禁止，测试沙箱的远程控制、OpenAI 远程调用恢复为开启测试前的关闭状态。两端 Cindy 登录态及测试分享关系保留，正式版及原有供应没有重启或更改。`teardown-results.json` 记录恢复结果。

### 已知验证边界

- `claudeHosted.e2e.test.ts` 的 `releases an idle task...` 在 Windows 临时工作目录上出现 `EBUSY`。完整回归和单独重跑均失败；以原始 `HEAD` 对照运行同一用例，复现相同错误。本次没有改写或跳过该测试来制造全绿。后续应单独修复托管释放过程的 Windows 文件占用问题。
- Core 独立 `tsc --noEmit` 在未改动的 `packages/lizi-mcps/src/browser/recipe-loader.ts` 有 `ImportMeta.glob` 类型问题；Desktop 全量类型检查用于覆盖本次集成。不要为本功能放宽类型配置。
- 单页 UI 矩阵使用 Chromium；原 Electron 单页运行器在当前 Windows DPI 环境存在视口/截图问题。随后已通过完整 Electron 应用补充 Windows 明暗实机目检，macOS 仍未实机验证。
- Windows 同机双进程已完成真实跨账号分享、目录刷新、账号与供应端组限制、两条真实订阅请求；尚未在不同物理电脑和 macOS 上实测。远程组员绑定、多跳、离线、旧版、确认失败和跨区域消息处理使用测试夹具覆盖，本轮不声称已在生产跨区域服务验证。
- Claude 原生订阅仍走原生 CLI 授权和最高优先级设置，没有把它伪装成代理已抓包验证；当前一轮中原生更新尚未确认时，必须保持待确认语义。

## 8. 发布与使用

本次交付为源码、测试和文档。用户另行授权 rebase、提交 PR 和自动跟进；提交前追加验证见[审查记录](subscription-fast-policy-review.md)。没有部署、更新或重启正在提供服务的 Cindy。真实账号测试只在两个隔离开发沙箱内进行；没有修改正式版偏好或订阅凭证。

建议按组内电脑逐台更新，再更新组所在电脑。关闭 Fast 后检查待确认提示：所有参与执行的电脑确认后再视为全组已经应用。接收方目录刷新只是额外展示保护，不需要接收方手工更新组才能执行限制。

若需要恢复，先在 UI 中重新允许 Fast，等待限制解除确认。不要直接删除组策略记录来代替解除：离线成员需要收到更高修订才能清理旧约束。应用降级会失去新版执行能力，不应把降级当成受控状态。
