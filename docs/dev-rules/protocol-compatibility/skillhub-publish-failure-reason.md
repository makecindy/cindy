# SkillHub 发布失败原因

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

发布错误继续使用 `{ error: { code, message } }`，Desktop 保留已知业务码与具体原因，
同步用于进度事件和 IPC 结果回退；短原因也展示。未知 4xx 错误保留业务原因，网络故障、
限流和服务不可用各自提供重试建议。缺少标准错误码的 HTTP 403 也归为权限不足，不引导编辑请求。
只有明确的业务拒绝原因可展示原文；认证、权限不足（含 `NOT_AUTHOR`）、凭证配置、只读能力、限流、
服务不可用及未预期的内部异常使用恢复文案，不展示原始诊断，包括异步结果与复制内容。
init/commit 的服务端拒绝在主进程过滤非公开详情；非标准 `HTTP_*` 回退也不透传原始 message，
未知但符合错误体契约的 4xx 业务码仍保留公开原因，客户端使用固定提示补足空详情。
主进程的本地可见范围拒绝只返回 `INVALID_VISIBILITY`，由 Renderer 使用当前语言的恢复提示，
不透传硬编码英文；服务端的可见范围业务原因仍可展示。
新服务端的 `SKILL_DELETED`（409）表示同名技能已删除但名称仍被占用，客户端引导改名；
新客户端兼容旧服务端 `FORBIDDEN` + “已删除的 Skill 不能继续发布”。旧客户端遇到新错误码
仍可按原有通用提示降级，不要求同步发布。

后台处理失败复用扫描结果的 `gates[].issues[]`（severity、code、message），客户端
同时识别失败项的 issue 错误码与旧版错误码检查项名称，展示具体原因与相应修改建议，
避免把包校验或名称冲突描述为安全审核失败；只对失败检查项进行该分类，已通过项、
warn/warning 状态检查项、等待或处理中的检查项和 warning issue
不参与失败分类。`package-validation`、`publication`、`publication-processing`、`upload-processing`
表示发布处理检查项，其中未知错误使用内部失败的公开恢复说明，并移除诊断路径与证据；
普通安全扫描的 findings 继续保留具体原因与相对文件位置。旧客户端本来就能
展示 issue。服务端只向上传者返回会话原因，公开目录权限不变；未知内部异常仍返回公开的
重试说明。实现与回归见 `shared/skillhubPublishErrors.ts`、`publishService.test.ts`、
`PublishDialog.feedback.test.tsx` 和 `ScanResultDialog.test.tsx`。
