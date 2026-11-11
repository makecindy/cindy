# 供应商分享：按授权查看额度与用量（2026-10-19）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

- 新只读通道 `provider-share:insights:v1` 仅接受分享身份，参数严格为 `{ version: 1, includeUsage: boolean }`，供应商由已验证身份决定。
  返回 `{ version, capabilities, status, quota, usage }`，结构和接收端白名单解析在 `shared/providerShareInsights.ts`；
  两项能力默认关闭，未开放无数据，读取失败分别标 unavailable。无版本/能力/状态或未知版本提示更新，不降为管理通道。
  `includeUsage: false` 仍返回独立能力位；获准用量标 `not-requested`、usage 为 null，不读账本、不投影或返回缓存历史。
  仅主动展开时传 true，收起后恢复 false，离开/隐藏详情不再发请求，未请求与未开放/失败/零用量明确区分。
  新通道 v1 首次发布即要求 includeUsage；缺少或非布尔值拒绝，不回退为全量读取。
  已发布旧端不支持此新通道；新端提示更新。接收端同时拒绝折叠请求却附带历史的响应，不降为全量查询。
- 同账号 `manage-share` 追加 `get-visibility`、`set-visibility`（按供应商，仅 quota/usage 布尔补丁）、`quota-account`。
  写入仍只在供应商所在电脑执行；旧端的 Unknown command 映射为 UNSUPPORTED_CAPABILITY，不改存控制端、不重放写入。
  受邀者不能调用这些管理动作，也不能指定另一个 providerId 或借通道读取全量账本。
- 最终发送、重复请求与 outbox 重发核对读取时的账号、成员和可见性代次；开关关闭再开启使旧投影失效。
  新通道不进入通用 completed 结果缓存；受邀端白名单重建响应并丢弃未授权字段，账号/分享变动拒绝在途回包。
  只读请求不调用远程 Agent，不占任务名额。历史和额度分别合并短期在途读取，缓存不跨账号。
- 普通额度为一项，组额度仅返回自有账号匿名数组及 partial 标记，不含设备、上游身份、凭证或第三方分享账号额度。
  用量按天/模型/公开昵称头像投影，合并设备维度，转来用量匿名汇总；历史裁剪口径沿用 usage-history。
  最终投影还按 UTF-8 JSON 总字节限制在 `MAX_FRAME_BYTES - 1024`，预留 invoke 信封空间；预算包括昵称/头像、额度和历史行。
  继续裁剪时优先保留较新的历史并更新 `coverageStart`；人员资料本身超限或连一行历史也无法容纳时，将 usage 标 unavailable，
  不静默删除人员、不伪造零用量，也不让它拖掉可用 quota。quota 本身超限时独立标 unavailable。没有新增 wire 字段。
- 旧受邀端不发新请求，模型使用不变；新受邀端收到 CHANNEL_NOT_ALLOWED 或不完整能力时显示需要更新。
  relay 信封、服务端、数据库与 Mobile 均不变；完整查看需要双方 Desktop 更新。
  实现与回归：`device-link/providerShareInsights.ts`、`dispatch.ts`、同目录 `__tests__/providerShareInsights.test.ts`、`providerShareDispatch.test.ts`。
