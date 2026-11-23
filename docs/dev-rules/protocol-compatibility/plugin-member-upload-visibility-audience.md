# 企业插件发布时选择可见范围

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

成员上传 prepare（`POST /api/publisher/uploads`，Connection JWT）在 `sizeBytes`、`sha256` 之外
新增可选 `visibilityAudience`：`{ type: 'all' }`，或 `{ type: 'matchAny', membershipIds?,
departmentIds?, emails?, roles? }`。服务端在本次上传成功（finalize）时写入插件：新插件在首个
版本上架后按此范围可见，已有插件立即生效；角色条件只能保留已有的，新角色被忽略。规则正本在
plugin-server 的 `parseVisibilityAudience`，客户端 `packages/plugin-protocol/src/visibilityAudience.ts`
按相同规则校验与归一（去重排序、邮箱小写、`matchAny` 至少一项、每类最多 500 项），两仓用同一
组有效／无效样例（`memberUpload.test.ts`）。prepare 解析器与服务端一样只检查字段是对象。

**旧服务端降级。** #1553 之前的服务端对任何多余字段返回 `400 INVALID_PARAMS`（不接受字段），
且不创建上传会话。客户端按三层处理，不依赖错误文案（成员上传错误详情在客户端被隐藏）：

1. **先探测。** 弹确认屏前用 Access Token 读作者接口 `GET /api/personal/plugins`；返回 404 视为
   旧服务端，确认屏不显示可见范围，prepare 不带该字段，体验与升级前一致。
2. **只在范围确实改变时发送。** 新插件选「全部成员」、已有插件范围未改、或读不到当前范围
   （本人不是创建者／维护者，确认屏显示「沿用当前范围」）时都不带字段。
3. **不悄悄放宽或忽略。** 发送了字段却收到 400 `INVALID_PARAMS`（灰度期间打到旧实例）时，
   不去掉字段重试，本次发布失败并提示「服务暂不支持指定可见范围」，用户可改选或稍后再试。

用户在对话里明确指定了范围（`audience_hint`）而服务端或插件无法按范围发布（旧服务端、读不到
当前范围）时，确认屏说明原因并阻止本次发布，主进程同样拒绝，不按全员或沿用范围发出。

旧客户端不发送该字段，服务端行为不变，无需同步升级。作者接口与选人接口（`/api/personal/plugins*`、
auth-server `/api/me/colleagues*`、`/api/me/skill-audience-departments`）只在新服务端使用，旧服务端
返回 404 时客户端隐藏相应能力。实现与回归见 `plugin-publisher/orchestrator.ts`、
`plugin-publisher/audienceContext.ts` 及其测试。
