# 个人社区插件发布 HTTP / DTO 契约

2026-10-16，v2。两仓逐字共享，产品流程见共享方案 `plugin_community_contribution.md`。
实现不等于生产部署；本地验证与上线前提分别见两服务文档。

## 1. 身份与包

普通接口前缀 `/api/plugin-contributions`，沿 Host 当前配置的 Plugin Server。
使用普通 Auth Access Token，经 `requireAuth` 验签，接受 `ctx=personal|org`。
主体为可信 issuer authority + membershipId；请求体、包内 author、版本或本地安装均不是授权证据。
公开投稿归当前提交账号本人管理；组织管理员身份不授予其他成员投稿的管理权，不合并个人与组织身份。
组织内部发布和私域插件继续原流程，不通过此入口转为公开。此入口不接受 GitHub OIDC、Connection 或 Platform token，不增加 scope，也不回退鉴权。
所有本人响应回显 `subject:{authority,membershipId}`；Host 在返回前核对 owner 和主体。
AI 不接触 Bearer、PUT URL 或原包路径。

运行批准和安装来源只代表本机使用事实，不证明作者身份，也不授予发布权。Host 核对可信安装来源；普通市场安装不能自动作为本人开发的新插件首发。已有 public 插件始终要求当前提交主体的精确提交授权。新标识受理是等待人工审核的发布申请，首发事务建立的初始提交权和固定作者关系不表示平台已认证代码作者；服务端不接受客户端自报来源或作者字段代替这些校验。

`ghost.json.releaseNotes` 是可选字符串，缺此字段仍可安装。首次上架不要求更新说明，
插件用途写在 `description`；从未上架的插件在退回或取消后再提审也不要求更新说明。
曾上架后再提审须填写非空说明，完整覆盖相对上一已上架版本的变化；下架不免除此要求。
服务端依据现有 `listedAt` 记录判断，并在提交事务中复核。
不增加作者表单、版本基准字段、翻译资料或独立上传文件选择。
服务器验证字段和精确包，人工判断说明完整性，校验不执行插件代码。

### 发布署名与匿名设置（2026-10-19）

本节仅适用于 `scope=public` 的官方插件和个人社区插件。两类同属 public，`publisherKind:official|personal|null` 由固定的 `PluginAuthorship.kind` 派生；个人昵称为 Cindy 也不会成为官方。组织插件沿用原发布、署名、搜索和交付规则。

- 官方来源继续通过 GitHub Actions OIDC、精确官方仓库名与不变 repository_id 校验，固定署名 Cindy，不能通过个人匿名设置隐藏或变更官方身份。
- 个人首发在同一事务绑定已验证的 authority + membershipId；作者归属不随后续提交授权变更。预检或仅上传不占用归属。
- 原作者提审时，Plugin 使用该请求的用户 Token 调用原 Auth `GET /api/me`，核对返回的 Membership id 和 kind 与当前提交身份一致，将昵称保存至已有 `PluginRelease.displayAuthor` 和该次回执的 `manifestView.author`。只读本人资料，Token 不持久化，不新增 Auth 作者 API、公开作者映射或机器凭证。
- 改名不会自动同步旧版本；原作者下次提审保存新的昵称。其他维护者提审沿用已保存的原作者署名，不能改成维护者本人名字。绑定、昵称快照与审计信息继续完整记录。
- 当前仅在生成响应时短路个人署名：公开列表、搜索、详情、本人管理详情及历史内容的展示署名统一返回 null，展示 manifest 不含作者；不受已保存的 anonymous 偏好影响，也不通过个人昵称搜索命中。读取投影不改写数据库中的作者绑定、版本昵称或回执内容。
- `PATCH /api/plugin-contributions/plugins/:pluginId/author-settings` 保留原个人鉴权、写限流和固定作者归属校验，只接受 `{anonymous:boolean}`。保存偏好不改变当前个人署名统一隐藏的返回规则，客户端界面不提供开关。提交 ACL 不授予该设置权限，原作者失去提交权也不会因此失去固定归属。可选 `authorSettings:{anonymous,canEdit}|null` 仍表示服务端保存的事实，不接受客户端指定作者、Auth 来源或昵称。
- 市场读取仅访问 Plugin 自有数据库，不依赖 Auth 在线或个人会话。原始下载包保持不变；隐藏平台展示署名不清除开发者自行写入代码、文档或包内容的个人信息。

昵称最多100字符。可选 `displayAuthor:string|null` 的显式 null 不回退包内作者；旧协议 `author` 与嵌套展示 manifest.author 在64字符以内保持相同，长昵称分别 null / 缺失，不截断。Host 的 installedAuthor 继续要求来源、已批准 SHA 和账本一致，只更新署名投影。

保留已应用的 `20261019010000_plugin_authorship`，通过增量 `20261019020000_plugin_author_privacy` 将不再使用的 publicAuthorId 替换为一个默认匿名布尔值；官方已有关系设为非匿名。昵称使用已有列，不新增姓名表；移除本轮未交付的 Auth 公开作者草稿。用户确认无历史个人社区插件，本轮无个人作者回填；本地已应用的旧迁移不改校验和，不清库。部署前仍需完成迁移与鉴权边界的人工 review，未自动部署。

## 2. 预检与提审

`GET /preflight?ghostId=&version=&pluginId=&hasReleaseNotes=true|false`：pluginId 可省略；hasReleaseNotes 只说明当前包是否含非空更新说明，未提供视为 false。仅只读，不建 operation、授权、票据或版本。
仅当插件曾上架且当前包缺说明时返回 `RELEASE_NOTES_REQUIRED`；客户端声明不代替提交时对实际包的校验。
返回如下字段（UTC ISO 毫秒时间；SHA 为64位小写十六进制）：

```ts
type Subject = { authority: string; membershipId: string };
type Revision = { releaseId: string; sha256: string; displayUpdatedAt: string };
type Preflight = {
  subject: Subject; queriedAt: string; policyVersion: 2;
  target: { pluginId: string | null; ghostId: string; version: string; expectedRelease: Revision | null };
  pendingRelease: { releaseId: string; version: string } | null;
  blockers: Array<{ code: string; message: string }>;
  actions: { canSubmit: boolean };
};
```

现有目标只通过本人精确 ACL / 已核实 legacy alias 解析。新身份遇到同名冲突不会自动认领。
预检验证远端已用版本、实际待审和当前提交权限；Host 另核对本地说明及快照。
符合来源条件且具有发布资格的本地详情展示实际版本与完整说明，明确“成功提审后版本不可复用”；普通市场安装者不进入发布准备流程。
直接点击版本提审即公开提交，无第二份资料表单或预览确认；UI / AI 共用 Host。
提交前再次核对当前安装内容、批准及 owner，变化时停止并要求刷新。

`POST /prepare`，`Idempotency-Key` 为 UUID。严格请求：

```ts
type Prepare = {
  sizeBytes: number; sha256: string; source: 'manual' | 'ai';
  target: { pluginId: string | null; ghostId: string; version: string; expectedRelease: Revision | null };
};
```

同键绑定完整规范化请求，不能换包或目标。201 新操作、200 原键恢复。
返回 operation 及 `upload:{putUrl,headers,expiresAt}|null`，原包 PUT 后：

- `POST /operations/:id/commit {}` → 202 `{subject,operationId,status}`。
- `GET /operations/:id` → 原操作和不可变回执、即时审核投影。
- `status` 为 awaiting_upload / validating / publishing / succeeded / failed / expired。
- succeeded 才有 receipt；202 不表示已提审，PUT 成功也不表示受理。
- receipt 含 operationId/submissionId/pluginId/releaseId/ghostId/version/source/submittedAt，
  uploadedPackage{sha256,sizeBytes}、releaseRevision 和 outcome。
- v2 成功新提审 outcome=submitted_for_review；旧回执 metadata_updated / unchanged 仍可读，
  不允许借旧 outcome 绕过新版本规则。

暂态 Auth/JWKS、存储、事务或未知网络结果释放当前租约并保留原操作，5秒退避后显式恢复同 commit。
Host 在远程写入前落盘键和原请求，不保存 token/票据；切号停止旧任务，旧 generation 不能回写。
未知结果先 GET 原操作，非终态重放同 commit，不重新 prepare / PUT / 新键。
停止上传只中止本机任务，不取消审核或删除服务端事实。

## 3. 个人提审的版本规则

同一 canonical pluginId + version 只能成功提审一次，取消/退回/通过/撤权/下架均不释放版本。
prepare、上传、坏包、明确未提交审核不消费版本；未知结果先查询原操作。
个人入口对每插件同时至多允许一个实际 pending 审核版本。GitHub/OIDC、组织成员人工审核和组织免审保持原有规则。

写入复用既有 namespace 和 Release→Plugin 锁序，新 Release 只锁 Plugin。
锁后重查版本、待审、当前提交权限及租约；同一事务写包事实、精确修订的 `review.submit` 审计、回执及 operation 成功。
个人入口不覆盖既有 Release；历史比较包和发布事件不作为提交或审核前置条件。

## 4. 本人插件、版本与取消

| 入口 | 返回/语义 |
|---|---|
| GET /plugins?query=&filter=&limit=&cursor= | subject/queriedAt/plugins/nextCursor；filter=all/pending/action_required/listed；服务端筛选分页 |
| GET /plugins/:id | plugin、latestSubmissionContent、分页 history；市场与最近版本分开 |
| GET /plugins/:id/releases?version=&limit=&cursor= | 每 Release 当前修订一项，不能用操作回执数量充当版本 |
| GET /plugins/:id/history?limit=&cursor= | 独立 eventId、类型、精确 revision 或 null、完整原因与游标 |
| GET /plugins/:id/submissions/:submissionId | receipt、匹配修订的 submission、原提交 content 或明确 null |

SubmissionView 包含 revision/revisionState、reviewStatus（pending/approved/rejected/cancelled 或未知 null）、
submittedAt、approvedAt、cancelledAt、decidedAt、reason 和 actions.canCancelReview。
真实时间取匹配修订的事件；旧资料无法核实时为 null，不能拿包创建/上传时间或当前状态补造。
content 留存规范化 manifest/manifestView/icon；不是原始 manifest 字节。旧内容未知不借当前包补齐。
市场状态独立为 pluginStatus/currentRelease/available/unavailableReason，approved 不等于已上架。

`POST /plugins/:pluginId/releases/:releaseId/cancel-review`：

```json
{"expectedRelease":{"releaseId":"exact-release","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","displayUpdatedAt":"2026-10-16T10:42:00.000Z"}}
```

仅本次个人提审原发起人且仍有精确 ACL 可取消；不设计多作者代取消。
事务中 Release→Plugin 加锁、核对 receipt/修订/授权并用当前 bearer 再验签。
pending→cancelled 与 `plugin.review.cancel` 原子写入；重复不产生新事件或取消时间。
已通过或退回时返回真实终局，不伪称取消成功。响应 `{subject,queriedAt,pluginId,submission}`。
取消不撤销当前上架包，不释放版本，不伪装为 rejected/revoked。
客户端使用现有确认框说明版本不可复用，无原因表单；所选待审版本才有取消按钮。

“我的插件”每插件一行，主体是名称、当前市场与最新情况，不展示提交次数。
进入插件后版本选择统领状态、提审/通过时间、说明、原因与操作，历史和技术资料默认收起。
当前市场与所选版本相同则合并展示；查看旧版本可定位待审版本。
上传问题附在所属插件，完整消息可读；不叫“本机发布记录”，不在列表上方铺流水。
前台、进入页面、手动刷新或网络恢复时读取，无后台审核轮询或通知。
撤权后只保留本人回执及匹配历史，不泄露他人的后续待审内容。

## 5. Platform 审核与来源

管理读取 additive `release.contribution` 只标记真实匹配个人回执；内部 publishSource 仍为 console_upload，
本人 API 派生 community_upload；无回执不推断来源，也不扩老来源 enum。
旧邮箱路径不得用于个人版本，个人发布不新增任何通知。
个人版本在原后台详情补充来源、提交身份和包内更新说明，不增加提交者管理或独立审核页面。
Web / CLI 沿用原 approve/reject 请求及 `expectedReleaseUpdatedAt` 修订检查，复用原待审队列、审核、上架与驳回流程。
不增加审核阅读令牌、发布基准或历史比较包门槛；个人接口没有额外启用开关。

## 6. 错误与恢复

| code | 含义与合法下一步 |
|---|---|
| RELEASE_NOTES_REQUIRED | 曾上架插件的更新缺说明，尚未提交审核、未占号；修改包内 releaseNotes 并重新安装 |
| VERSION_ALREADY_SUBMITTED | 已用版本；查看结果，修改需换号 |
| PLUGIN_PENDING_RELEASE_EXISTS | 已有实际待审；先查看或取消该版本 |
| CONTRIBUTION_PACKAGE_CHANGED | 摘要后本地内容变化，未开始上传；刷新摘要 |
| CONTRIBUTION_REVISION_STALE / PLUGIN_REVIEW_STALE | 目标或待审修订变化，刷新并重新核对 |

主体/ACL/重复键/坏包/体积/过期等沿既有精确错误，不把具体原因统一覆盖成“失败”。
没有终态证据时只显示处理中/结果待核对，不声称版本未占用。

## 7. 迁移与本地验证

`20261016010000_plugin_review_cancellation` 只扩 review enum cancelled 和审计索引；
个人三表与旧审计修订触发器仍由前一 migration 提供。

公开投稿接口部署后即可使用，个人或组织成员沿当前登录身份及当前插件权限校验，不增加启用开关或开通资格。
不清理或迁移旧 GitHub/组织待审队列；旧渠道继续原流程。
历史 migration 的开关注释已不适用，保留已应用迁移的校验和。
新增 cancelled 的 reader 兼容须在合并部署前核实，不得让不支持该值的旧 reader 与新写入混跑；写入后回滚须保留兼容 reader。

两仓相关选测、真实隔离数据库与本地接口证据在交付时写入对应服务/客户端说明。
源码、mock 测试、本地新库演练均不等于存量生产滚动演练或部署许可。
