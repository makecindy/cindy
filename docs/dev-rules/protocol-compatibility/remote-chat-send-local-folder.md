# 远程聊天发送本机文件夹

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

桌面拖入／粘贴本机文件夹时，控制端通过本地 `maker:chat-folder:upload` 自动打包，
作为普通文件附件放入现有草稿暂存区；发送时复用附件传输（直连优先、OSS 回退），
大小限制和重试行为与普通文件一致。preload 桥只接受原生 `File`，
由隔离世界的 Electron `webUtils.getPathForFile` 取路径；拒绝内存构造的 File，
不接受 Renderer 自选的源路径。`file-browser:remote-op` 的 `caps` 新增可选
`folderAttachment`；缺少能力时明确提示更新，不把控制端路径当作远程目录发送。
归档携带 `application/x-cindy-folder-tar` MIME；接收端通过普通附件物化入口下载到对应
任务，再安全解包到归档旁的 `.contents` 目录，Agent 和消息历史引用解包后的路径。
聊天附件的符号链接必须为相对路径且最终指向解包树内已有条目；绝对路径、越界、
悬空或循环链接导致解包失败并回滚。目录内有效链接链保留，普通目录下载策略不变。
归档与目录共用附件的发送失败回滚、排队移除和任务删除清理，不新增文件夹归属记录、
导入任务或回收定时器。发送前对端只有普通附件传输暂存，复用直传／OSS 原有过期回收。
本机草稿归档复用 `chat-attachment-cache` 的账号隔离与显式丢弃清理；不会因短 TTL
删除仍在使用的草稿。新建任务草稿无需工作目录。打包／解包不完整时整次失败。
发送等待打包完成，失败保留草稿；切换任务／取消后清理迟到暂存结果。
等待发送期间从聊天区外层拖入的后续文件夹也必须完成，任意一项失败均保留原草稿。
当前任务文件栏的目录拖拽携带来源标记，继续直接引用。SSH 入口目前明确提示不支持，
不传本机路径；手机没有本机目录拖拽入口。本次不改 relay、服务端或持久化 schema。
实现与回归见 `file-browser/chat-folder-transfer.ts`、`chatFolderTransfer.test.ts` 和
`chatInputAnnotationAbort.test.tsx`。
