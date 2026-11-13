# 手动对齐 worktree 源分支

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`worktree:list-branches` 的 IPC 响应可选追加 `remoteDefaultBranch`
（完整的 `refs/remotes/origin/*` 引用）；仅 UI 查询补充，失败不影响本地分支列表，
创建使用的 `listBranches()` 保持原样。列表仍按原有约定懒加载。
本地支持刷新；控制端查询 `worktree:branch-sync-status`，旧被控端返回
`DEVICE_LINK_CHANNEL_NOT_ALLOWED` 时隐藏刷新按钮，缺少可选字段时不显示远程分组，
本地分支选择与创建保持原行为。新被控端继续接受旧请求。
状态查询只读本地 Git；缺本地 tracking ref 不代表远程分支不存在，仍允许拉取。
仅拉取确认远程分支不存在后，在本次胶囊选择内置灰；换分支或重新挂载即重新判断。
同步仅由用户点击触发，按配置的 tracking remote/ref（否则 origin 同名分支）拉取一个显式
refspec，再按需快进本地分支。
手动 fetch 使用 `--progress`，连续 60 秒没有新增对象、接收字节或解包进度才超时；
重复进度行与普通输出不续期。本地探测仍有 5 秒上限，超时沿用整棵进程树清理。
单次命令用 `-c fetch.unpackLimit=1` 让小批对象也经过会报告字节进度的 `index-pack`，
避免单个大对象被 `unpack-objects` 静默接收时误判停滞；不修改用户 Git 配置。
新版控制端在 `worktree:sync-branch` 请求追加可选 `waitForResult: true`，被控端至多等待
10 秒，未完成时返回 `{ pending: true, operationId }`。后续请求带同一 `operationId`，
只等待原操作，绝不重新 fetch；句柄绑定账号代次、控制设备、仓库和分支。
运行中操作上限 64 个；已完成结果独立保留最多 64 个、最长 5 分钟，超量淘汰最早完成者，
不占用运行配额，也不淘汰运行中的操作。轮询连接错误后保留已收到的句柄，用户再次点击
只续接原操作；收到终态、终态错误或切换选择后清除句柄，不自动重放初始写请求。
未知、过期或不匹配的句柄报 `branch-sync:changed`，不自动重新执行。每次 invoke 仍沿用
90 秒传输预算，不修改共享链路的超时、重试或恢复策略；两个控制端的句柄互不通用。
旧控制端不传新字段，新被控端仍返回原终态；新控制端连接旧被控端时接受原终态，沿用旧端
Git 超时。长下载的完整体验需要两端更新。失败不重放写请求、不重置 peer 或 relay；
创建和发送不等待同步，不改用其它源引用。手机本轮不提供入口。无服务端或数据库变更。
实现见 `apps/desktop/src/main/worktree/branchSync.ts`；真实 Git 回归在
`branchSync.git-integration.test.ts`。
