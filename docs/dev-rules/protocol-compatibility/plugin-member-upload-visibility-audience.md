# 企业插件发布时选择可见范围

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

成员上传 prepare（`POST /api/publisher/uploads`，Connection JWT）在 `sizeBytes`、`sha256` 之外
新增可选 `visibilityAudience`：`{ type: 'all' }`，或 `{ type: 'matchAny', membershipIds?,
departmentIds?, emails?, roles? }`。服务端在本次上传成功（finalize）时写入插件：新插件在首个
版本上架后按此范围可见，已有插件立即生效；角色条件只能保留已有的，新角色被忽略。规则正本在
plugin-server 的 `parseVisibilityAudience`，客户端 `packages/plugin-protocol/src/visibilityAudience.ts`
按相同规则校验与归一（去重排序、邮箱小写、`matchAny` 至少一项、每类最多 500 项），两仓用同一
组有效／无效样例（`memberUpload.test.ts`）。prepare 解析器与服务端一样只检查字段是对象。

**服务端前提。** 客户端依赖 cindy-server #1553（作者接口、prepare 的 `visibilityAudience`）与 #1593
（列表与详情的 `latestReviewEvent`、`GET /api/personal/plugins/publish-context`），不再兼容更早的
服务端：#1593 上线正式环境后客户端才能发版。只保留一层低成本的退化——作者列表
`GET /api/personal/plugins` 整体 404（没有作者接口）时隐藏「团队共享」。

**成员的部门与按部门搜索。** 同事搜索、部门成员、按 ID 查人、维护者与 `visibilityAudienceMembers`
里的成员可带可选的主部门 `department: { id, name } | null`（cindy-server #1651），界面显示「名字 ·
部门」；字段缺失、为 null 或格式不对时改显示邮箱，旧服务端照常可用。`GET /api/me/colleagues?q=`
不加参数（cindy-server #1665）：服务端先返回姓名、邮箱、拼音匹配的在职成员，不足 20 人时补上名称
包含 q 的部门（按部门排序取前 5 个，含子部门）里的在职成员，去重后最多 20 人，`%`、`_` 按字面匹配；
旧服务端只按姓名和邮箱匹配。可见范围选择器里，搜索到的成员所在
部门（或其上级）已选中时显示「已包含」，与部门树一致。

**发布确认屏。** 弹确认屏前用 Access Token 读 `publish-context?ghostId=`：
1. `exists: false` → 新插件，默认全部成员，可编辑；
2. `canEdit: true`（创建者、维护者或有插件管理权限）→ 带出当前范围，可编辑；
3. `canEdit: false` 或读取失败 → 「沿用当前范围」，不可改、不带字段；当前范围含五种角色之外的
   旧角色时同样沿用，并提示发布后到插件详情修改（上传严格解析角色）；
4. `403`（未开启成员发布或无发布权限）与 `409 PLUGIN_ARCHIVED / COMMON_PLUGIN_MANAGED /
   PLUGIN_REPOSITORY_MANAGED`（这些错误对任何人的上传都会出现）→ 确认屏说明原因并阻止，
   发布以同样的错误码结束。

**只在范围确实改变时发送。** 新插件选「全部成员」、已有插件范围未改，或只能沿用时都不带字段，
避免用没改过的副本覆盖他人在别处的修改。用户在对话里明确指定了范围（`audience_hint`）而只能
沿用时，确认屏说明原因并阻止本次发布，主进程同样拒绝，不按沿用范围发出。

旧客户端不发送该字段，服务端行为不变。实现与回归见 `plugin-publisher/orchestrator.ts`、
`plugin-publisher/audienceContext.ts` 及其测试。
