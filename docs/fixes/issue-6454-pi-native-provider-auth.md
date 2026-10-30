# #6454：Pi 原生供应商别名缺少 auth 的修复方案

## 目标与失败判据

使用设备码授权的 MiniMax（中国大陆）连接，在自动化中选择 MiniMax-M3，发送「回复：你好」应得到回复。实际复现先出现 `provider.auth.oauth` 扩展错误，再以 `undefined is not an object (evaluating 'provider.auth.apiKey')` 结束，未生成回复。Issue 使用 M3.1-Flash-Preview；本机 M3 也触发，说明模型名称不是必要条件。

本次以最新 `origin/main` 的 9d3d13aa5639116988d9943f39b18b4c14dd8362 为基线。原工作区、已有连接及自动化保持原状。

## 证据与根因

2026-10-19 22:11:57–22:12:07（Asia/Shanghai）的复现运行使用 Pi 与 MiniMax-M3。agent 日志先记录 `session_start` 中的 `provider.auth.oauth` 错误，随后记录 `provider.auth.apiKey`。`rpc-ready` / `first-model-request` 阶段的成功标记不能证明上游 HTTP 已发出。原运行的临时模型目录已不可读，不能声称核验过该次实际 models.json 或进程环境。

调用链为：Desktop `pi-host.ts` 准备 nativeProviders → maker-core 生成 models.json 和别名 → `native-provider-adapter-source.ts` 的 `registerAliases` → Pi 对象形式的 `registerProvider`。OAuth 由 Cindy 现有 loopback 代理及订阅 header 承担，因此别名没有 `keyEnv`；注册代码却只在有 `keyEnv` 时提供 `auth`。Pi Native Provider 契约要求 auth 对象，即使没有 API key/OAuth 方法也必须提供空对象。

Pi 1.1.0 的 `registerNativeProvider` 在读取 `provider.auth.oauth` 前已更新供应商状态，异常不会自动撤销已注册对象；后续凭证解析再访问 `provider.auth.apiKey`，形成用户看到的第二个错误。客户端不应依赖这种部分失败状态。

独立隔离的真实 Pi 1.1.0 与 1.0.2 对照实验均得到：

| 输入 | 退出码 | loopback 请求 | 回复 |
| --- | --- | --- | --- |
| 无 keyEnv，省略 auth（原实现） | 1 | 0 | 无，两个 auth 属性错误 |
| 无 keyEnv，auth 为 {} | 0 | 1 | fixture-ok |
| 有 keyEnv，保留 envApiKeyAuth | 0 | 1 | fixture-ok |
| 仅 models.json、不注册别名 | 0 | 1 | fixture-ok |

实验只使用本地 SSE fixture、假凭证与独立临时目录，不连接真实 MiniMax。它证明注册契约缺陷与最小修复可行，不等价于真实账号端到端验收。

关联分析：[#6454](https://github.com/makecindy/cindy/issues/6454)；原生别名接入来自 [#4402](https://github.com/makecindy/cindy/pull/4402)，会话内刷新来自 [#5274](https://github.com/makecindy/cindy/pull/5274)。未发现关联修复 PR，不能把功能 PR 当成已有修复。

## 最小改动与自检

统一在 `registerAliases` 里提供 `auth: alias.keyEnv ? { apiKey: envApiKeyAuth(...) } : {}`。保留对象注册、供应商专属序列化、连接独立 ID、原生 stream/streamSimple、models.json 的 `pi-native-keyless` 占位，以及已有 OAuth 代理/header。无需让用户重新授权、购买另一模型或增加开关，也无需升级 Pi pin。

方案自检：

- auth 是注册元数据，不是真实 OAuth 凭证；空对象不声称支持 Pi 自己的 OAuth 登录，也不增加凭证落盘。
- 有 keyEnv 时仍用原来的 envApiKeyAuth，不得统一清空为 {}。
- 启动 `session_start` 与 refresh 共用同一函数，补齐两条入口；刷新仍按现有 nonce、环境白名单与注销范围执行。
- 同根因适用于所有无 keyEnv 的别名，而非仅 MiniMax/M3；回归用无 keyEnv 的代表并验证有 keyEnv 的对照。
- 不关闭能力、不更改错误吞吐、不新增 fallback，不修改上游 Pi、目录、数据库、协议或 UI。

## 实施与回归计划

1. 在已有 `nativeProviderAdapterRefresh.test.ts` 执行真实生成的扩展源，通过注入 Pi API 测试 session_start 与 refresh：无 keyEnv 不再因 auth 缺失失败，有 keyEnv 的解析器保留，刷新后新模型可见。
2. 先在未修复代码上运行回归，保留原始失败判据；实施一处注册修正后重跑。
3. 扩展已有 `piNativeAdapterRuntime.test.ts` 的真实 Pi loopback 用例，加入无 keyEnv、models.json 占位认证的 MiniMax；保留 Copilot、Cloudflare 有 keyEnv 对照。断言进程成功、真实请求与回复、订阅 header 传递；不访问用户账号。
4. 运行相关单测、maker-core 实际 build（tsc --noEmit）、受影响 package 的 typecheck、测试卫生与 diff 检查；按个人流程记录门禁、DCO 提交、完整 diff 自审，再由独立只读 Reviewer 审查最终版本。
5. 门禁与独立审查通过后交用户验收；验收前不 push 或创建 PR。

### 逐端覆盖与边界

| 端/入口 | 覆盖与验证 | 边界 |
| --- | --- | --- |
| Desktop macOS 本机 Pi、自动化 | 共享注册/刷新行为单测；真实 Pi loopback 进程，既有 native adapter、refresh 与 host 相关测试 | 本机执行；真实 MiniMax 账号待当前修复构建验收 |
| Desktop Windows/Linux、SSH Pi | 同一生成扩展与别名代码；跨平台路径由现有测试构造 | 非本机 OS 未实跑；SSH 不改配置/传输，目标环境仍待验证 |
| iOS/Android 远控任务 | Pi 在所属 Desktop/远程主机执行，复用同一修复 | 无手机内置 Pi 子进程；移动 UI、wire 不变；未做设备端到端验收 |
| Cindy headless 消费者 | 复用 maker-core Pi 注册代码；共享行为回归与类型检查 | 无 headless 专属分支，不声称实际部署已更新 |

### 风险与恢复

唯一产品行为变化是让原先缺少 auth 而异常的注册满足 Pi 契约。风险重点为 API key 分支被误改、刷新路径漏修、代理 header 或独立 provider 身份丢失；用上述对照及现有回归约束。失败只影响当前 Pi 任务，不重启共享服务或其它 peer。已失败进程中可能存在部分注册状态；发布修复后应重新启动该任务运行时再验证，不能声称正在运行的旧进程会自动修好。无需用户数据迁移；回退代码可恢复旧行为但会恢复此 bug。

## 验证记录

2026-10-19，macOS arm64：新增共享回归在原实现报 `Cannot read properties of undefined (reading oauth)`；真实 Pi 1.0.2 的新增 MiniMax 用例在原实现报与用户日志一致的 oauth/apiKey 两个错误（既有两个 keyed 用例通过）。修正后两个共享文件共 10 条用例通过，真实运行时文件 3 条用例全部执行并通过，包含请求、回复和代理 header 断言。运行时文件墙钟 1.11 秒，共享文件合跑 0.54 秒，均在单文件 5 秒预算内。

提交前门禁与最终独立审查以本任务 Git 元数据目录中的 local-delivery 真实回执及 PR 拟稿记录为准。非本机平台、SSH 实机与真实账号验收未执行，不能用跳过的运行时测试冒充通过。
