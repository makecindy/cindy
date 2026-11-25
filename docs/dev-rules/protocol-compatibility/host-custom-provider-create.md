# Host 自定义供应商创建与模型发现

独立 Host 通过 `hostChannelContract.ts` 增量提供两个契约通道：

| Desktop / Device Link channel | Web API | Host POST 路径与请求体 |
| --- | --- | --- |
| `maker:provider:custom:create` | `maker.createCustomProvider(config, keys, options?)` | `/api/providers/custom/create`：`{ config, keys, options }` |
| `maker:provider:models-fetch` | `maker.fetchProviderModels(input)` | `/api/providers/models-fetch`：`{ input }` |

两个入口均要求传输层认证的 `context.caller`，缺席返回 403
`authenticated_controller_required`；请求体不提供控制端身份。Desktop 委托前仍校验可信窗口，
Host 在独立 Desktop 占用同一配置目录时拒绝这两个入口。沿用 Host 的 owner
准入与 Desktop `registerProviderHandlers` 校验、mutation queue、凭据暂存回滚及
owner generation 校验。配置写入现有 `custom_providers`，API Key 与请求头写入现有
owner 隔离的加密凭据存储；成功后刷新目录并发布 `maker:provider:changed`。
模型发现沿用 Desktop 的输入校验及已存请求头的端点绑定，不将密文头交回浏览器。

这是旧契约上的加法，不修改通用 `/api/ipc` 只读登记表，不增加 relay wire 字段。
新 Host 兼容旧客户端；新客户端连接旧 Host 时接口不可用，需升级 Host，不回退直接写库
或向客户端暴露已存秘密。写操作不新增自动重放；重复创建相同 ID 按现有逻辑拒绝。
更新、删除与断开通道未接入，仍显式不支持。

实现：`apps/host/src/agent/provider-config.ts`、`apps/host/src/service.mjs`。
回归：`apps/host/src/agent/provider-config.test.mjs`、`apps/host/src/web-shim.test.mjs`、
`packages/maker-shared/src/__tests__/hostChannelContract.test.ts`。
真实 NAS 添加供应商、拉取模型与流式回复仍须实机验收；单测不代表部署或发行已完成。
