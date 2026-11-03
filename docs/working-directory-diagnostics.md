# 工作目录异常：日志判读

本次诊断只增加可观测性，不修改目录探测的超时预算、恢复判据、目录授权或 Agent 行为。
它不会修复原目录，也不会主动搬动用户文件。

## 收集

问题出现后记下发生时间和客户端版本，通过现有“上传日志”入口提供诊断日志。
本机也可以在当前实例的日志目录中搜索当天的 main 日志，筛选 scope
`workdir-diagnostics`。默认 info 等级即可记录，不需要打开 debug；自定义日志等级仍然生效。
这些日志需要运行包含本次改动的客户端版本，旧版本无法补录。

## 关联字段

| 字段 | 用途 |
| --- | --- |
| `directoryRef` / `probedDirectoryRef` | 关联目标目录与恢复过程中实际检查的祖先目录 |
| `sessionRef` | 关联同一个任务的检查、恢复和运行时重建 |
| `requestId` / `workerId` | 关联一次探测请求与承载它的进程 |
| `elapsedMs` / `queueWaitMs` / `responseWaitMs` | 总耗时、排队耗时、派发后的结果等待耗时 |
| `activeWorkers` / `terminatingWorkers` / `queued` | 判断是否忙于处理其他请求，或等待旧进程退出 |
| `code` / `causeCode` | 已知错误码；不认识的错误码统一为 `UNKNOWN`，不输出原始异常 |

目录和任务关联标识采用进程内随机密钥的 HMAC；同一次运行可关联，重启后改变。
它们不是目录原文，也不是可用来还原路径的普通路径哈希。符号链接等不同路径拼法不保证标识相同。

## 探测阶段

| 日志中的 `reason` | 能确认的事实 |
| --- | --- |
| `queue-full` | 等候队列达到上限，本请求没有派发 |
| `queue-timeout` | 等待进程空位耗尽预算，没有开始检查目标目录 |
| `deadline-before-dispatch` | 准备派发时总预算已耗尽 |
| `host-start-failed` / `host-restart-failed` | 创建探测进程失败；有底层已知错误时看 `causeCode` |
| `dispatch-failed` | 向探测进程发送请求失败 |
| `host-error` / `host-exited` | 探测进程异常或未返回结果就退出 |
| `response-timeout` | 请求已经派发，但未在预算内收到结果 |
| `filesystem-error` | 探测进程返回文件操作错误；看 `code` 区分 `ENOENT`、`EACCES`、`EIO` 等 |
| `not-directory` | 文件操作返回目标不是目录 |
| `disposed` | 探测池已关闭或正在关闭，不能把它当作目录缺失 |

**`response-timeout` 不能单独证明硬盘损坏或掉盘。** 当前内部协议没有文件操作开始回执，
它仍可能包含进程启动、文件操作或进程间通信等待；日志不会把未知原因伪装成确定的磁盘故障。
进程的创建、终止请求、kill 未获确认和最终退出都有独立日志，退出记录带 `exitCode`
与 `terminationRequested`，可判断是超时后主动终止，还是意外退出。

## 恢复与发送阶段

- `workdir recovery unavailable`：看 `reason` 区分祖先探测错误、盘根缺失、裸挂载点和 `device-changed`；设备变化附预期与实际设备号。
- `workdir recovery directory created`：真正执行了原地 mkdir；`similarPathFound` 表示发现相似目录线索，不记录其名字。
- `workdir recovery completed`：`action=fallback-selected` 是选用备用目录，`action=fallback-recreated` 是重建备用目录，不能混同原目录被恢复。
- `sameDirectory=true`：备用目录与输入目录相同，是“回退到自身”的直接诊断证据；本次仅记录，不修改该行为。
- `workdir recovery attempt failed`：`stage` 指明失败在挂载检查、备用目录 stat/mkdir、相似目录检查、原目录 mkdir 还是别名解析。随后仍可能成功回退，不能只看这一条判断最终失败。
- `workdir preflight ready/recovered/blocked/rejected`：表示发送前检查的最终走向；`blocked` 同时记录真实错误码与实际报出的 `reportedReason`，可识别“探测器故障却报目录不存在”。
- `workdir DB lookup failed`：读 DB 路径失败；`workdir DB fallback candidate` 记录存在 DB 候选，`sameNormalizedDirectory=true` 表示只是规范化后的路径拼法相同，本次不改变比较或发送逻辑。
- `workdir runtime refresh requested/completed`：表示因目录问题请求重建运行时及其结果；结合前面的目录检查日志判断重建为何成功或被阻断。

按发生时间先找 `preflight failed/blocked`，用 `sessionRef` 和 `directoryRef` 关联恢复记录，
再用目录标识找到对应探测的 `reason`、请求编号、耗时和进程状态。后续的 `preflight ready`
可以确认检查恢复正常，避免误判为只能重启客户端才能恢复。

## 上报边界

`workdir-diagnostics` 只按精确 scope 加入日志上传白名单。新增理由是该来源只包含
固定事件名、已知错误码、数值、布尔值和匿名关联标识，不包含目录、文件名、任务标题、
消息、凭证或原始异常。其子 scope、Renderer 转发及原有 `maker-ipc` / `workdir-probe-host`
不会因此获得上传权限；现有授权、记录边界与脱敏规则保持不变。
