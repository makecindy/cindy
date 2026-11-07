# 插件读取任务最终回复中的文件引用

> 状态：代码已实现，尚未发布；不代表正式客户端 0.1.122 已支持。
> 范围裁决：只读现有明确引用，不新增交付登记，不声称覆盖全部交付物。

## 问题与已核实的来源

项目看板可以通过 `cindy.observe.projectTasks` 查询普通本机项目任务，并通过
`openTask` 打开原任务，但不能列出或打开结果文件。文件分组、折叠与看板布局属于插件；
任务可见性、引用来源与文件打开授权属于宿主。

基于官方 `main` 的 `02884c7dc9`：

- PR #8120 实现 `agent.observe`。`main/cindy-brain/pluginObserveSlot.ts` 只接受
  `project-tasks` 与 `open-task`；`shared/pluginObserve.ts` 不含文件字段。
- PR #7868（合并提交 `018663ea63294a566c83a7faaf62805905220572`）提供委派回执与
  单次文件票据，不是普通任务历史文件查询。
- `renderer/lib/generatedFiles.ts` 从工具调用派生新建文件，命令来源还需要时间窗验证；
  不能将这些候选统一称为已交付成果。
- `maker-ipc/register.ts` 的 `collectArtifacts` 从轮次变更集采集增改文件，写入
  委派回执的 `outputArtifactsJson`；它描述改动，不是所有普通任务的交付账本。
- `main/reviewer/reviewEvidence.ts` 读取历史附件时会另行请求原生授权。
  用户入站附件、工具产物和最终回复链接不能互相替代。

## 公开接口

新增 `cindy.observe.taskFiles({project, taskId})`
和 `cindy.observe.openFile({project, taskId, fileId})`。仅本机 Desktop 逻辑页支持，
手机页面与远端任务明确返回不支持；不增加跨设备透传。

查询返回不透明 `fileId`、展示文件名、引用时间、来源 `final-answer-link` 和本机可用状态。
不得返回宿主绝对路径、消息正文、工具参数或可直接下载的通用文件 URL。结果有界；
触及历史读取或返回数量上限时必须明确标为不完整，不能将截断伪装成完整空结果。

只接受带宿主持久化 turnCompleted:true、未撤回的主 assistant 回复中明确的文件链接。
仅有 final_answer phase 但尚未结束的流式回复不纳入；排除子 Agent 与私有回复。排除代码块、进度消息、
用户附件、普通文本里提及的路径与目录扫描结果。历史数据无法确认最终回复身份时，不推断。
列表代表“最终回复引用的文件”，不证明文件由该任务创建，也不保证内容仍与交付时一致。

## 授权与文件边界

现有 `agent.observe` 的确认文案明确不含文件。新增文件能力必须独立声明、独立批准；
旧 observe/tasks/targets 批准不能自动授予。原有插件的启用、配置和批准继续有效。
拒绝新能力后不能自动反复弹窗，需保留用户主动重新确认的入口。

查询与打开都复用 `pluginObserveTasks.ts` 的任务可见性：已登记且存在的本机项目，
排除隐藏、已删除、伙伴专线、Review、Worker、SSH 与远端 Agent 任务。请求带项目，
主机核实任务当前仍属于同一项目；worktree 按任务真实绑定解析执行目录，不扫描主项目。

不透明标识绑定 owner、插件实例、批准修订、项目、任务、消息和具体引用。
账号切换、撤权、插件替换、任务隐藏或移动、消息撤回后不得继续使用。
所有异步读取结束后复核身份，在打开前再次核对授权、引用与文件。

首版只打开已验证位于任务执行目录内的普通本机文件。拒绝路径穿越、UNC/设备路径、
敏感或隐藏路径、越界符号链接及不能可靠核验的文件；不自动猜测其他目录或下载远端副本。
缺失、非本机、边界拒绝分别明确表达；只有可用文件能请求宿主预览。
预览使用已有宿主受控文件界面，不让插件执行任意本机程序或自行接收文件内容。

## 验证要求

- 最终回复链接与进度、代码示例、用户附件严格区分。
- project/task 不匹配、隐藏、远端、撤回、账号切换与撤权均拒绝。
- 标识伪造、跨插件重用、失效标识、软链逃逸、路径穿越与文件删除不能打开文件。
- 返回值与错误不泄漏消息全文或内部路径；部分结果明确标识。
- 旧 receipt 与历史未知字段不扩权、不停用；新批准仅在确认后持久化。
- SDK、类型、作者手册、权限文案与实现保持一致；相关单测与 package 类型检查通过。

本改动涉及插件基座，须按 `dev-rules/plugin-security-and-authoring.md` 第 5 节取得
指定维护者在 PR 上明确 Approve，方可合并。提交 PR 不表示正式版本已具备能力。

## 作者调用与结果

清单新增独立能力：

```json
{"agent":{"observe":true,"observeFiles":true}}
```

`observeFiles` 必须同时声明 `observe`。文件能力单列 `agent:observeFiles`，批准事实为
`observeFilesCapabilityApproved`；历史未知字段与旧批准不会授予。首次调用可确认，拒绝后
通过插件详情页主动重新确认。更新不移除旧插件的其它权限、配置或启用状态。

```js
if (typeof cindy.observe?.taskFiles !== 'function' ||
    typeof cindy.observe?.openFile !== 'function') {
  throw new Error('当前客户端不支持任务文件引用，请升级后使用');
}
const result = await cindy.observe.taskFiles({ project, taskId });
// result: {files: [{fileId, name, referencedAt, source, status}], partial}
// 在用户点击某个 available 文件时：
await cindy.observe.openFile({ project, taskId, fileId }); // {opened:true}
```

`referencedAt` 为来源消息的 Unix 毫秒时间；`source` 固定为 `final-answer-link`。
`available` 表示当前通过本机路径检查，`missing` 表示文件或真实 worktree 绑定缺失，
`not-local` 表示 UNC/其他平台等非本机引用，`blocked` 表示路径或文件类型被拒绝，
`unsupported` 表示暂不解析的 `cindy-media` 引用。结果不含文件内容、完整路径或消息全文。

读取最近最多 200 条未撤回 assistant 消息，每条最多 128,000 字符，超长整条跳过；
链接最多 4096 字符，返回最多 100 条引用。达到上限时 `partial:true`。同一消息同一 href
去重，不同消息可重复引用同名文件；插件自行展示、折叠，不按文件名推断唯一性。

标识仅在当前宿主进程和相同批准范围内有效；重启、重新安装、撤权、来源或执行目录变化后
应重新查询。文件从缺失恢复为可用时同样重新查询。`TARGET_UNAVAILABLE` 表示目标或标识
失效，`FILE_UNAVAILABLE` 表示文件当前不能打开，`PERMISSION_DENIED` 表示授权不再有效。
旧客户端或不支持的运行表面应停止调用并提示升级，不调用私有接口或扫描目录代替。

所有软链接（包括中间目录）和硬链接均拒绝。打开通过本机主窗口的侧栏文件浏览器，
保留原有 dirty guard 和文件服务的路径校验，不调用系统 shell，也不发出跨设备推送。
成功回执表示已请求宿主展示，不承诺渲染器已完成预览。文件内容是打开时的当前内容；
本接口不保存交付时快照，也不对文件系统并发修改提供原子快照保证。
Light/Dark 使用既有语义组件；隔离单页验证覆盖 12 种语言、深浅色及 320px 窄屏共 48 个组合，
并目检中文窄屏两种主题。未在运行中的正式客户端验证整条插件安装与文件预览链路。

聊天链接词法规则共用 shared/markdownLocalHref.ts：支持 canonical xdt-file://local/?path=、
sandbox: 绝对路径与行/列后缀；规范化后仍完整执行本接口的目录、文件类型和授权校验。
达到返回上限后立即停止解析剩余历史并标为 partial，仍执行最终来源与授权复核。
