# GLM Coding Plan 跨电脑额度摘要

同账号电脑的供应商目录可返回布尔字段 `zhipuCodingPlanUsage`。宿主根据真实路由、连接状态及「允许被远程调用」开关计算，控制端据此为菜单栏汇总请求 `maker:usage:zhipu-coding-plan`，参数为 `[{ providerId }]`。查询前与返回时均在宿主检查授权，凭证留在连接所在电脑。响应仅携带查询状态、已识别的套餐档位、额度窗口和更新时间。

旧宿主省略标记时控制端跳过该连接，遇到 `CHANNEL_NOT_ALLOWED` 也直接跳过。旧控制端忽略新增字段。调用沿用既有 Device Link invoke 信封和菜单栏刷新时机，自建中转透明转发，无需更改中转版本。
