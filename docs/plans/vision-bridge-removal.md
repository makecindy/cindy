# 视觉桥完整移除方案

> 状态：移除实现与本地验证已完成，待 PR／CI 审查。2026-11-17 方案初稿，2026-11-18 实施。
> 实施遵循已审方案：移除代码与入口，保留用户配置文件、凭据及历史资料。
> 二次审查：2026-11-17 更新到 `origin/main`（`0591b8ff9a`），复核下述调用链；原有本地诊断改动保持不动。

## 1. 目标与交付边界

完整移除 Cindy 自带的视觉桥：不再替其他模型读图，不再配置主／备用读图后端，不再由代理、消息发送或插件结果触发额外读图请求。
这不是隐藏设置、默认关闭，也不是把同一功能改名、改成订阅调用或搬到后台继续运行。

移除完成后：

- 视觉模型沿用各引擎已有的原生图片输入路径；供应商、账号、模型选择和鉴权不变。
- 非视觉模型不再获得自动图片描述。沿用现有引擎／供应商对不支持图片的处理，不新增替代读图服务，也不承诺所有引擎错误呈现一致。
- 文本聊天、伙伴、群聊、远程任务、图片上传／粘贴／存储／预览、原生工具返回图片仍正常工作。
- 不再新增视觉桥的提示、缓存、占位文本、专用工具和诊断日志。
- 已保存的历史消息、图片、工具结果和用户供应商凭据不删除、不改写。

原实现见 [视觉桥设计](../vision-bridge-design.md)。本文在实施完成前不取代现行功能说明；实施后原设计应标记为已退役的历史记录，并链接实际移除结果，不能继续宣称功能可用。

## 2. 必须完整拆除的路径

完整路径以仓库根为起点；表中 `main/`、`renderer/`、`preload/`、`shared/` 简写均指 `apps/desktop/src/` 下，`agents/` 简写指 `packages/maker-core/src/agents/`。表中是删除／修改定位清单，不授权整文件删除共享代码。

| 范围 | 实际入口与处理要求 |
| --- | --- |
| Desktop 专属实现 | 删除 `apps/desktop/src/main/vision-bridge/` 的控制器、核心、读图请求、主备编排、缓存、配置 store、Pi env 构造和工具图片描述器，以及专属测试。目录里的临时诊断文件也纳入清理。 |
| Desktop 装配 | 在 `main/maker-host/index.ts` 删除实例建立／释放、全局控制器注册、网关凭据读取器的专属注入、提示事件去重、Maker hook、Pi env 和插件图片描述回调装配。保留共享 maker 生命周期与凭据服务。 |
| 普通发送与插话 | `packages/maker-core/src/session.ts` 删除 `bridgedVisionMessage` 及 `send`、`steer` 调用；`maker.ts`、`agents/base-agent.ts`、`types/vision-bridge.ts`、`types/index.ts` 删除专属参数、字段、类型和导出。完整反查引用，不留下未使用 hook。 |
| 代理层 | 删除 `packages/anthropic-compat-proxy/src/vision-bridge-transform.ts` 及专属测试、导出；解除 `main/maker-host/anthropicCompatProxyHostCore.ts`、`codex-proxy-host.ts` 的视觉转换挂载。通用 transform、Responses／Messages 协议转换和原生图片转换保留。 |
| 专属路由 | 在 `main/maker-host/provider-route.ts` 删除 `resolveVisionBackendRoute` 及仅为它存在的 reader、类型、辅助函数；逐项确认无其他消费者。禁止删除正常会话的供应商路由、账号解析和共用协议判据。 |
| Pi | 删除 `agents/pi/cindy-bridge-source.ts` 中 Cindy 注入的 `vision`、`vision-locate` 工具及专属请求、提示、解析、超时辅助；删除 `CINDY_PI_VISION_BRIDGE`、`resolvePiVisionBridgeEnv` 的注入链，覆盖 `agents/pi/index.ts`、`base-agent.ts`、Desktop `pi-host.ts`。保留整个通用 Cindy bridge 和 Pi 原生工具／用户扩展。 |
| 插件结果增强 | `main/mcp-integrations/ghost.ts` 删除 `buildToolResultImageDescriptions`、专属图片扫描／预算／告警，以及 `describeToolResultImage`、`onToolResultImagesFailed` 注入；`mcp-providers.ts` 删除转接字段。保留原始插件返回体、媒体确权、入库、权限检查及图片卡展示。 |
| Node Host | 删除 `apps/host/src/agent/vision-bridge.ts` 及专属测试；在 `agent/runtime.ts` 和 `main.ts` 删除构建、activate、hook、Pi env、返回对象和关闭步骤。Desktop 与 Host 必须同轮完成。 |
| 设置与选择器 | 删除 `VisionBridgeSection.tsx`、其 `.settings-search.ts`、专属渲染测试、`shared/visionBridgeSettings.ts`；清理 `SettingsView.tsx`、`PersonalizationSettings.settings-search.ts` 和相关 mock。`ModelSelector.tsx` 仅移除专属 `vision-bridge-local-proxy` 原因值，不改通用模型选择行为。 |
| IPC 与公开类型 | 清理 `main/maker-ipc/channels.ts`、`bootstrap-electron.ts`、`preload/preload.ts`、`renderer/vite-env.d.ts` 中 get／set／reset 接口与类型；先完成第 4 节消费者核验。 |
| Agent 发现 | 删除 `packages/lizi-mcps/src/xdt-helper/control-catalog.ts` 的 `models.vision` 项，反查设置导航、能力索引与覆盖台账，避免 Agent 仍能发现一个失效功能。 |
| 前端事件 | 清理 `renderer/lib/makerChatStore.ts` 中视觉桥 recognizing／fallback／unavailable 特殊消费与清理状态，不删除共用事件处理和正常错误提示。历史事件按通用记录处理，不重新生成读图任务。 |
| 迁移与预览 | 删除 `main/setup-migration/settingsGroups.ts` 中专属设置登记；清理 `apps/web/shim.js` 的视觉桥静态配置及接口占位、设置搜索 fixture。保留通用未知设置组的兼容处理。 |

## 3. 必须保留的共享能力

不能用 `vision`、`image` 或 `bridge` 单词全局替换／整片删除。

1. `packages/model-providers/src/visionCapability.ts` 与导出／测试保留：`shared/modelImageInputOverride.ts` 和 `ModelAdvancedDrawer.tsx` 仍使用图片能力判断。
2. 原生图片内容块、附件协议、图片优化、媒体引用和 blob 回收保留。已确认 `session.ts` 的 `appendManagedImageReferences` 只有视觉桥一个调用点，应连同定义及该文件的 `formatManagedImageReferences` import 删除；`agents/shared/managed-image-reference.ts` 的格式化实现必须保留，Claude Code／Codex／Pi 原生适配器各自仍调用它。
3. `session.ts` 的发送 reservation、取消、授权钩子、turn generation 复核和状态回滚保留。尤其 `steer` 删除视觉转换后仍会等待 `beforeProviderStart`，不能因旧注释提到视觉桥而删除跨轮保护。
4. 插件的 `producedMedia` 账本、媒体白名单和原始响应透传保留。同名的媒体收集函数可能属于消息持久化／Reviewer，不得按函数名批量删除。
5. API／OAuth／网关凭据、模型目录、正常代理、Pi MCP／权限桥、用户安装的视觉扩展均不在删除范围内。
6. 服务端、历史数据库 migration、插件 manifest／批准记录均不改。若实现意外需要改变这些边界，先重新评估方案，不能当作清理附带修改。

## 4. 旧配置、旧端与历史结果

“删干净”指移除活跃产品能力与专属实现，不等于擦除用户已有资料。

- `vision-bridge-settings.json`：新版本不读、不写、不监听、不迁移进新配置；已有文件原地保留，不加启动清理器。文件不会令已删除功能恢复。回退旧版本后旧版本可能再次读取，这是回退行为，不能宣称文件已物理清除。
- 不删除供应商 Key、OAuth 登录或图片文件；视觉桥复用的是公共资源，不拥有其生命周期。
- `maker:vision-bridge-settings:{get,set,reset}`：目前查到 Desktop 自身入口和 Web shim，尚未在 `packages/device-link` 检索到同名声明。实施时还须核对动态 allowlist、Host 通道派生与旧客户端，不能仅凭字符串未命中断言无跨端影响。
- 二次核验：Device Link 的调用白名单在 `packages/device-link/src/allowlist.ts` 由显式集合构成；Host HTTP IPC 通过 `apps/host/src/ipc-route.mjs` 使用 `packages/maker-shared` 注册合同。现有合同／binding 未发现视觉桥设置接口。默认方案为删除这三个私有 IPC，不预设新增兼容 handler；实施基线若出现新消费者，按下一条重新核定。
- 同版私有 IPC 直接随消费者删除，不为不存在的消费者留下空壳。若确认有受支持旧端调用，只保留必要且明确返回“能力已移除”的兼容边界，记录调用方和退出条件；不得返回“设置成功”或继续落盘，不得加载旧视觉核心。
- `xdt_media_descriptions`：`packages/cindy-tools/src/types.ts` 有可选类型，`__tests__/ghostMcp.test.ts` 有透传测试。删除 Host 自动生成路径；是否删除该类型按实际 wire 消费者确认。普通未知字段透传必须继续工作，旧结果不能因该字段存在而报错、丢图或重复渲染。
- 新版不再发布 `vision`／`vision-locate`，旧历史中的工具调用仍作为记录展示；不重新注册工具去模拟成功。用户自己安装的同名扩展不受影响。
- 配置迁移必须分方向验证：旧源 → 新目标时，旧快照里的 `visionBridge` 组沿用 `setup-migration/apply.ts` 的未知组 `skipped` 结果，不写配置，不阻断其他组；新源 → 旧目标时，新快照不包含该组，不清空旧目标已存设置。两种方向均不返回该组“已应用”。
- 远程事件与设置接口是两回事：旧宿主仍可能通过通用 `maker:event` 向新控制端发送视觉桥非终态提示。删除专属 toast 后，通用事件处理须继续尊重 `isTerminal: false`，不能把正常进行的任务标成失败、打断流或挂住 loading。不删除通用事件白名单，也不改变旧宿主执行行为；“不再发读图请求”的保证只适用于已升级的执行宿主。
- 已运行的旧进程不会因为源码修改自动卸载功能；验收须重启到新构建，确认没有复用旧 Pi 子进程／旧 Host，并记录实际构建版本。

兼容评估依据：[协议兼容](../dev-rules/protocol-compatibility.md)、[插件兼容](../dev-rules/plugin-security-and-authoring.md)、[配置与覆盖](../dev-rules/configuration-and-overrides.md)。兼容层若确需存在，不得被隐瞒为“零残留”。

## 5. 文案、文档、生成内容与测试

- Desktop 各语言 `common.json` 删除失去消费者的视觉桥 key；Desktop／Mobile 群聊的 `IMAGE_INPUT_UNSUPPORTED` 是仍有效的通用错误，保留错误本身，只去掉“到设置开启视觉桥”的建议。Mobile 各语言 `groupChat.json` 都要检查，不能只搜索英文漏掉中文等译文。
- 清理 `apps/desktop/help-knowledge/personalization.md`，按仓库生成流程更新 `main/maker-ipc/helpKnowledge.generated.ts`，不得只手改生成文件。
- 处理 `i18n/glossary.json` 的专属术语并重新生成 `GLOSSARY.md`；保留历史文档引用的语义，不能一边退役功能一边留下当前使用说明。
- 同步 Host feature parity、通道覆盖与 Agent 控制覆盖说明；核对 `scripts/host-channel-coverage.mjs` 与 `docs/host/channel-coverage.md` 的生成关系。
- 历史 evidence JSON、历史计划、本文及退役设计可以保留事实性提及。不得重写旧证据声称当时没有功能；当前能力清单必须明确已移除。
- 专属正向测试随功能删除；混合文件保留其他断言，包括 `providerRoute.test.ts`、`codexProxyHost.test.ts`、`hostDesktopSourceContracts.guard.test.ts`、Pi guest 隔离测试、设置／模型选择测试和 `ghostMcp.test.ts`。
- `hostDesktopSourceContracts.guard.test.ts` 有以 `resolvePiVisionBridgeEnv:` 为切片边界的非专属断言，移除字段后须换准确边界，不能顺手删除保护其他装配一致性的断言。
- 共用代理 transform 的顺序与 guest 供应商分享隔离保持不变：只移除视觉 transform 项及其专属 guard，不顺带合并、重排剩余变换或删除 guest 参数。其余参数是否变成无调用者逐一反查。
- `scripts/test-hygiene-baseline.json` 不手工改基线放行。删除测试后的 stale entry／fileTimings 按现有工具维护；不以测试数量下降代表验收通过。
- 本工作区原有的读图诊断改动（`vision-channel.ts`、其测试和未跟踪 `vision-diagnostics.ts`）属于本功能；实施时检查 diff 后随模块退役，不通过 reset 覆盖工作区其他改动。本轮文档工作保留它们原样。

## 6. 实施顺序

以下是同一次完整交付的工作顺序，不把仅隐藏 UI 的中间状态交付给用户。

1. 更新基线并重新核验本清单；读 Desktop、maker-core、Pi、Host、媒体、协议和插件专项规则。若触及 system prompt 或插件基座确认范围，按实际 diff 说明影响并走相应门禁，不以“只是删除”豁免。
2. 从调用方解除四条路径：消息发送／插话、代理转换、Pi 专用工具、插件结果自动描述；Desktop 与 Host 一起解除装配。
3. 删除专属实现和类型，保留第 3 节共享能力；处理第 4 节已核实的兼容边界。
4. 删除设置、导航、IPC、预览、迁移登记、事件状态和文案，完成文档及生成内容同步。
5. 跑下述验收，再按第 8 节扫描反查。发现遗漏消费者就修调用链，禁止添加空实现掩盖错误。

## 7. 验收矩阵与通过标准

实现阶段沿用已有生产入口测试；只有存在覆盖缺口才增加最小回归，不写“源码不含某字符串”来代替行为测试。

| 场景 | 必须观察到的结果 |
| --- | --- |
| Claude Code／Codex／Pi 文本聊天 | 路由仍选中原供应商、账号和型号，正常返回；无视觉桥附加请求。 |
| 三引擎原生视觉模型 | 粘贴、上传、插话图片走原生输入，图片及媒体引用保留；不出现自动描述替换或视觉桥占位。 |
| 非视觉模型发图 | 不调用主／备用读图服务，不生成伪描述；原有输入限制／上游失败明确记录，不能假定必须识图成功。 |
| 取消与插话竞态 | 取消后不迟发；授权等待后旧 turn 的插话不能进入新 turn；不影响其他任务。 |
| 插件图片结果 | 原始结果与图片卡保留，不自动补描述，不重复卡片；媒体授权和确权测试仍通过。 |
| Pi | Cindy 专属两个工具不再注册、视觉凭据 env 不再注入；原生图片、其他 Cindy 工具和用户扩展仍可用。 |
| Desktop／Host | 启动与退出无缺失 import／残留控制器；两端均无视觉转换，不出现只删 Desktop 的差异。 |
| 设置／Agent／Web 预览 | 不再提供入口、搜索项、可写配置或失效占位；通用设置与模型选择可用。 |
| 升级／历史 | 带旧视觉桥配置可启动，既不读取其后端设置也不发额外代读请求；原生看图仍可用。旧消息和插件结果可打开；已有账号不要求重登或重配。 |
| 配置迁移 | 旧源的视觉桥组在新目标明确 skipped，其他设置继续迁移；新源不输出该组，旧目标现有资料不被清除。 |
| 手机／远程 | 新端发图到新宿主正常；旧控制端 → 新宿主不触发代读；新控制端收到旧宿主的非终态事件不误结束任务。旧宿主仍可按旧版配置读图，不算新版执行代码残留。 |
| 伙伴／群聊／供应商分享 | 共用入口的文本及原生图片保持正常，访客不越权调用本机其他供应商；无视觉模型错误不再建议开启已移除功能。 |

代码验证：更新相关测试比较基线后运行 `pnpm test:unit:related`，或等效定向验证；对所有实际受影响 package 做类型检查，必须包含 Desktop、maker-core 和 Host。按改动补跑 i18n、帮助生成一致性、通道覆盖、文档检查。UI 按设计规则检查深浅色，未实机验证项明确标注。

运行时证据记录构建 SHA、引擎／供应商身份、输入方式和结果；通过请求 spy／计数确认没有额外视觉请求，不记录真实 Key 或图片正文。不能以“找不到设置入口”替代执行路径验收。

## 8. 完整性扫描与允许残留

实施结束在已跟踪文件及本次新文件中检索以下族，逐项归属；扫生产代码之外也检查测试、导出、fixture、脚本、生成文档和预览：

```text
vision-bridge / visionBridge / VisionBridge / VisionBackend / vision-channel
resolveVisionBackend / setVisionGatewayKeyReader / resolvePiVisionBridgeEnv
CINDY_PI_VISION_BRIDGE / describeToolResultImage / buildToolResultImageDescriptions
onToolResultImagesFailed / IMAGE_INPUT_UNSUPPORTED
xdt_media_descriptions / models.vision / vision-bridge-local-proxy
visionBridgeSettings / vision-bridge-recognizing / vision-bridge-fallback / vision-bridge-unavailable
vision-locate / 视觉桥 / Vision Bridge
appendManagedImageReferences / pickVisionAgent / dismissVisionBridgeToast
```

通过标准：专属执行代码、配置写入、工具注册、请求发出和当前功能入口均为零；共享能力测试通过。允许残留仅限历史记录、退役说明、本文，以及已经证实必要的只读／拒绝式兼容边界。每个兼容残留要有用途和退出条件，不保留通用 `enable=false`、空控制器、无调用 helper 或未消费环境变量。

`vision`、图片能力判断和普通协议 bridge 命中应人工确认其共享用途，不要求这些通用词零命中。旧用户配置文件不属于仓库代码扫描目标。

## 9. 本轮自审记录

方式：按调用链与反向引用人工自审，未委派独立 reviewer。核对主干与工作区，未执行功能移除或声称运行验收完成。

| 发现 | 已纳入方案的修正 |
| --- | --- |
| 只搜视觉桥目录漏掉插件增强和协议字段 | 补齐 `ghost.ts`、`mcp-providers.ts`、`packages/cindy-tools` 的描述字段与透传边界。 |
| 删除 `steer` 视觉等待可能顺带删除通用并发保护 | 明确保留授权等待后的 generation 检查、reservation 与回滚。 |
| Desktop 删完仍可能由 Host 或 Pi 发请求 | 单列 Host 装配和 Pi 工具／env，要求同次交付并重启验收。 |
| 共用视觉能力分类被误认成专属实现 | 保留 `visionCapability.ts` 及高级设置消费者。 |
| UI 消失但发现／预览／迁移还暴露入口 | 补齐 Agent catalog、Web shim、fixture、迁移登记和帮助生成内容。 |
| 无视觉桥字样的失败回调和通用错误文案易遗漏 | 补齐 `onToolResultImagesFailed`；保留 `IMAGE_INPUT_UNSUPPORTED`，仅去除已退役功能的操作建议。 |
| 混合 guard 用被删字段定位其他代码 | 要求更新准确切片边界，不能删除其余契约断言。 |
| 追求零字符串命中可能破坏历史与兼容 | 区分零活跃能力、历史记录和必要兼容边界，逐项说明残留。 |

仍须实施时确认：动态跨端消费者、旧端支持范围、混合测试实际结果与原生图片运行验证。本方案已给出处理原则与验收条件，这些未验证项不伪装成完成。

本轮文档验证：`pnpm check:dev-docs` 11 项通过；本文相对链接全部可解析，工作区 `git diff --check` 通过。以上仅是文档检查，不代表第 7 节运行验收已执行。

### 二次审查结果

- 修正死代码遗漏：明确删除 session 内专属附件引用 helper，保留三引擎原生引用格式化器。
- 收紧兼容范围：当前未发现设置 IPC 的跨端合同，默认删除，不为假想消费者留空接口。
- 补齐真实跨端路径：旧宿主的 `maker:event` 非终态消息仍可能到达新控制端，必须独立验证，不能与私有设置 IPC 混为一谈。
- 把迁移的未知组处理从泛泛“兼容”落实为两个方向的 `skipped`／不输出结果。
- 补齐代理顺序、供应商分享与伙伴群聊的保护，以及准确的文件路径简写规则。
- 删除验收中的“带旧配置不读图”歧义：停止的是代读请求，不是模型原生看图。

以上为文档修订；生产代码、实际兼容运行和功能移除仍未执行。实施后的每一项检查需记录独立结果，不能用本次文档审查替代。


## 10. 实施记录（2026-11-18）

已拆除第 2 节列出的四条执行路径、Desktop／Host 装配、配置 API 与入口、Pi 两个专用工具、专属类型、缓存、提示及诊断模块；共享模型能力判断和三引擎原生图片引用格式化器保留。旧配置没有读取、写入或自动删除动作。

唯一生产兼容残留是 Renderer 对旧宿主 `source: vision-bridge` 且 `isTerminal: false` 提示的忽略边界：不注册工具、不发请求、不加载旧配置。原因是通用非终态错误逻辑会将闲置任务设成运行中；兼容边界阻止旧提示复活已结束任务，真正终态错误仍处理。待混合版本宿主不再发送此来源后可删除。

审查中保留并迁移了原专属测试文件中混入的 Host 授权与插话竞态保护到 `session.origin.test.ts`；增加原始图片块透传和旧宿主非终态提示回归。代理测试的变换数量减少一项，与实际移除吻合，其余代理断言保留。

已完成验证：Host 518 项通过；Desktop 路由／装配／选择器／设置定向检查中四个文件 136 项通过，代理文件两处数量断言已更新并在后续回归通过；后续 Desktop 402 项通过；maker-core 247 项通过、1 项原有跳过；插件透传 97 项通过；代理包 645 项通过。新增／迁移回归所在文件单独耗时：`session.origin.test.ts` 1.485 秒，`makerChatStoreLiveGeneration.test.ts` 0.011 秒。文档检查 15 项通过，i18n、术语、生成帮助及测试卫生通过。设置页单页校验 Light／Dark 2/2 通过并查看总览，覆盖真实 SettingsView 与本地 fixture，不代表真账号读图或跨端实测。

类型检查：maker-core、Host、代理包、cindy-tools、MCPS 已通过；Host 默认堆上限首次耗尽，按原检查范围提高进程堆上限后通过，未改项目配置。Desktop main／renderer、Mobile、model-providers 类型检查也已通过；Desktop 按相同两个项目分片执行并提高进程堆上限，未缩减检查范围。

未执行的能力验证：真实供应商付费图片请求、Windows／Linux 启动、手机远程新旧版本混合实机、用户扩展同名工具及完整旧账号升级。相关生产路径保留，不能将单测或单页 UI 结果宣称为这些实测通过。


隔离 Desktop 启动：`--mock --isolated=@worktree --passive` 返回 `DESKTOP_DEV_VERDICT=ready`，窗口与本地数据库就绪。启动时 Codex 后台用量读取出现原生 SQLite 初始化失败，未发送真实聊天／图片请求，不能据启动成功宣称该隔离环境的 Codex 实际模型调用通过。设置校验图片已按固定 SHA 发布到作者 fork，PR 引用生成的图片证据。


### 首轮 CI 跟进（2026-11-18）

Windows 单测第 5 分片发现群聊失败提示测试仍要求旧视觉桥设置建议；已改为验证仍有效的“切换到支持图片的模型”恢复路径，并明确不再出现视觉桥建议。全语言反查另发现 Mobile 日文、韩文 details 漏清，已改为同一错误现有的 advice；无新增入口、文案方案或运行逻辑。补清已删除字段遗留的注释，保留共享能力与测试。相关 Renderer 两文件 19 项通过，i18n 与术语检查通过。

Windows 数据库 job 的失败为既有迁移回放用例 `normalizes duplicate worker labels deterministically before enforcing uniqueness` 超过 60 秒，伴随 Vitest worker 的 `onTaskUpdate` 通信超时。本 PR 未改 schema、migration、数据库 runner 或该测试。本机从真实迁移生产入口定向复跑该用例，1 项通过（0.328 秒），25 项因名称过滤未执行；这不是完整迁移验收或 Windows 通过的证据。不改迁移、不抬高超时、不弱化断言，随修复推送触发新一轮 Windows CI，继续观察。


### 主干冲突同步（2026-11-18，基于 3958ec711a8）

主干新增视觉桥辅助用量记录后，与本 PR 已删除的实现及 Pi 装配发生冲突。合入该主干，保留其他主干改动；删除随视觉桥一起退役的新 `piVisionUsage`、Pi 私有收据通知／子运行 spool 读写、对应依赖及仅验证这些已移除行为的测试。通用辅助用量记录、历史账目的来源名称、原生图片输入、普通 Pi 子运行与账号清理边界保留。未修改 CI、超时、凭证处理、历史图片或用户数据。

本轮验证：

- maker-core、Desktop main／renderer、Host 完整类型检查通过。Host 默认 4 GiB 堆耗尽后，以 12 GiB 堆按同一完整范围重跑通过，未缩减项目配置。
- Host 全量 522 项通过（65.401 秒）；Desktop Pi BYOM 13 项通过。
- maker-core 全量单测：6946 通过、61 跳过、1 项超时（70.44 秒）。超时的是未改动的 `collects canonical credential targets without flagging ordinary symlinks`，原有 5 秒上限和断言均保留；单独重跑整个 `cindyBridgeSource.test.ts`，58 通过、1 跳过（3.81 秒），该用例 1.388 秒通过。这不将此前全量运行改记为全绿。
- i18n、测试卫生、文档 15 项及相对主干的 diff 格式检查通过。自审确认本轮追加修改均服务于原移除范围，主干其他功能保留；合并带入的主干既有空白格式问题不另行清理。

原先披露的真实付费模型图片、跨平台启动、手机混合版本实机及完整旧账号升级缺口保持不变；本轮未重新执行这些验收。新 head 的完整 CI 仍须独立确认，维护者放行要求保持。
