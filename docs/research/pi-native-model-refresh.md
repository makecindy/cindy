# Cindy 对官方 Pi 的模型刷新适配

Cindy 必须适配官方 Pi，不修改 Pi 源码或二进制。此前方案假定的
`refresh_models` 和 `set_compaction_reserve_tokens` 并非官方 RPC；删除它们的调用及
配套补丁，不能要求用户安装定制 Pi 来完成普通切模。

## 官方接口

- Cindy 私有扩展命令通过 `ctx.modelRegistry.refresh({ allowNetwork: false })`
  读取目录，检查 `aborted` 与 provider errors，再用 `get_available_models` 核对目标。
- 已有原生适配器通过公开的 `unregisterProvider` / `registerProvider` 更新。
  只处理 Cindy 自己注册的项，用户扩展实例和会话保持连续。
- `set_model` 应用模型描述，`get_state` 确认实际 provider、model 和 contextWindow；
  同 ID 资料更新也必须重新应用。
- Pi 1.0 支持 `compaction.modelOverrides["provider/modelId"].reserveTokens`。
  Cindy 在启动前为可选模型生成预算，切模时 Pi 原生选择对应保留量。
- `pi.getSettings()` 仅在运行期读取配置副本。文件改写不代表运行中设置已更新，
  不能修改返回副本或访问 Pi 私有 SessionManager 伪装热更新。

接口依据：[Pi 1.0 扩展 API](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/extensions/types.ts)、
[原生设置解析](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/settings-manager.ts)。

## 切换与恢复边界

| 操作 | Cindy 处理 |
| --- | --- |
| 已加载模型或供应商间选择 | 保留进程、会话和扩展；使用原生 set_model 与按模型预算 |
| 凭据更新、目录更新且目标预算仍适用 | 私有 nonce 交接、原生目录刷新、重新应用模型 |
| 新模型、容量或工作预算变化，实际保留量不再匹配 | 变更前预览返回 rebuild，由已有宿主恢复流程加载启动配置 |
| 旧版 Pi 没有按模型配置能力 | 相同保留量仍可热切；需变化时使用同一恢复分支 |
| 内容已接近目标小窗口上限 | 先经过现有目标窗口保护与上下文接续 |
| 回合正在执行 | 等既有安全边界，不为模型选择中断回合 |
| 部分应用且无法确认路由 | 停止不确定的实例，保留任务记录以便恢复 |

普通切模不调用 `switch_session` 或扩展 `/reload`。真正不可热读的设置与普通供应商
变化分别处理；恢复保存的历史不等于保留扩展内存，不宣称恢复流程完全无损。

## 凭据与消费入口

私有命令只在确认扩展拥有该命令后调用。随机 nonce 绑定当前实例，凭据仅经受限的
extension UI 交接进入进程内存，不进入模型 prompt、聊天历史或明文配置。
`inspect` 仅返回运行中的设置；`refresh` 完成后返回相同设置快照。
不能把 prompt 接受回执当作刷新成功。失败需要回滚时恢复原文件字节。

桌面本机、远控、手机、IM、排队与定时任务仍走既有宿主选择和容量事务。
新子代理继承已确认的路由；已运行子代理保留独立身份。SSH 保留远端凭据与代理转发边界。

## 验证边界

定向测试覆盖原生供应商映射、凭据更新、同 ID 重选、按模型压缩预算、旧版本恢复判断、
失败回滚和远端文件操作。测试替身明确拒绝两个非官方 RPC，避免再引入该依赖。

另用未修改的官方 Pi 1.0、临时配置、假凭据和本地模拟服务验证真实桥接加载、公开
目录刷新、模型请求、会话与扩展连续性，以及压缩过程实际采用按模型保留量。
不启动 Cindy DEV，不读取个人授权或调用付费模型。具体执行结果写入 PR 验证记录。
Windows、真实 SSH、桌面与手机双设备交互需分别验收；隔离测试不代表已安装应用已更新。
