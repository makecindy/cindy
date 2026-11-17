# 插件任务流式预览（2026-11-17，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

插件管子 `tasks.capabilities()` 追加 `runPreview:true`；`tasks.getRun` 的 run 追加可选
`preview: { text: string }`（append-only）。只在 `status === 'running'` 且任务当前的执行实例与轮次
（`isSameSessionExecution`）仍是该 run 的执行时返回；内容取自本机 Session 正在输出、尚未落库的
那一段 assistant 文字（`getSessionTextSnapshot`，taskId 即 sessionId），经 `stripInternalWebCitations`
后保留开头最多 32768 个 UTF-16 字符，空则省略。它在工具调用后从新一段重新开始，不是最终输出；
结果仍按 `outputMessageId` 与 `readMessages` 读取。`listRuns` 不带此字段，回执不保存它。

不新增 manifest 权限、批准记录或数据迁移；归属检查与 `getRun` 相同，读取前再核对账号与插件批准，
只能看到本插件自建任务这次 run 的内容。读取在回执写队列之外同步完成，不让约 700 ms 的轮询排在
写操作后面。旧 Host 没有该标记和字段，插件按标记探测、只显示阶段。不涉及 device-link channel、
relay 帧或服务端请求，自建中转无需适配。浏览器扩展转交的进度文字见
[浏览器扩展桥接迁入宿主](browser-extension-bridge-in-host.md)。实现见 `maker-ipc/pluginTaskService.ts`
`getRun` 与 `register.ts` 的 `readLivePreview`，回归见 `pluginTaskService.test.ts`、`taskSlot.test.ts`。
