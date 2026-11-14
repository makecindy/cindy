# 上下文恢复的共用边界

这一步只提取桌面已有的终态所有权与恢复装配逻辑，为 Node Host 后续复用准备端口。
没有装配 Host 恢复入口，也不改变桌面的恢复策略、确认合同和持久格式。

## 已有工厂与新增边界

`contextOverflowRollover.ts`、`cindyContextCompression.ts`、`agentHandoff.ts` 和
`recoveryCoordinator.ts` 已经通过类型端口隔离平台能力，继续复用原文件。

| 共用文件 | 负责什么 | 留给平台的能力 |
| --- | --- | --- |
| `maker-ipc/contextRecoveryTerminal.ts` | 同步认领终态、暂扣失败、异步恢复成功后消耗原错误，失败后按原身份归还；重复终态只结算自己的暂存 | 恢复器持有者、错误暂存、错误持久化、事件出口、产品操作失败通知 |
| `maker-ipc/contextRecoveryAssembly.ts` | 恢复行联查与角色归一；只读历史分类后的 owner/数据库代次检查；重建事务前后围栏与零用量投影；内部重放的原意与来源检查；清除旧错误和取消恢复的顺序 | 当前数据库、目录授权读取、运行时发送、项目使用围栏、消息投影、交接卡与日志 |
| `localDb/contextRebuildPersistence.ts` | 构造重建标记并调用同一个 `context.rebuild` 事务 | 当前数据库的事务函数、时间与标识符生成 |

桌面原有导出与装配入口保留。函数端口使用调用时转调；表、符号键和平台对象通过 getter
读取，不在模块加载时捕获当前 owner、数据库、恢复器或队列。新增文件只有类型依赖。
抽取自查中，声明返回 `void` 的端口只作为语句调用，不读取其实际返回值；TypeScript
允许返回对象的实现满足 `void` 合同，不能据此推断返回的是 Promise。

终态处理分两段：先在原事件栈内同步 claim 并暂扣失败，再启动异步结算，事件管线不等待
恢复完成。失败通知的两个局部闭包仍由桌面持有，因为其他终态路径也会使用它们。
暂存匹配仍比较原事件身份，旧恢复的回调不能清掉后来一轮的条目。没有恢复 owner 时的
补广播与后续伙伴、Worker、供应商组收尾不在新终态主体内。

重建协调先读投影数据，再检查 owner 与数据库代次、执行事务、再次检查，随后发布
SDK 会话已清空与零用量投影。派生交接卡失败只记日志，不把已提交的重建改判为失败。
持久层保留同一次时间、原标记字段及 null/undefined 区别，不改变 SQL 或事务名。

## 特征测试与搬移证据

提取之前先增加两类测试，并在未提取的生产代码上运行：

- `sessionRuntimeControlWiring.test.ts` 在 guard tier 执行桌面真实装配闭包，注入平台 IO，
  验证联查角色、只读分类、owner/数据库围栏、提交与投影顺序、重放来源及同步回调顺序。
  它不启动整个 Electron 注册过程，也不复制这些闭包的实现。
- `messagesProjectionOwner.test.ts` 直接调用桌面 `commitContextRebuild` 导出，验证实际传给
  事务的标记、时间、被拒 SDK 与显式空值。事务自身仍由原数据库测试覆盖。

搬移后保留同样的行为断言；原有终态管线测试逐项对照。交付证据还包括逐段 token 对照、
各桌面入口已有模块的加载相对顺序、运行时导入闭包、lint 与 main 的同环境对照、类型检查，
以及两种池、空 HOME 和无引擎干净工作树的门禁。空 HOME 只用于直接启动的 Node/vitest
测试进程，pnpm 工具链缓存不计入测试隔离目录。

## 后续 Host 装配前必须确定的事项

- `onRebuilt` 与 `getRecoveryAbortSignal` 保持同步合同，忽略 `clearError` 的返回值。
  Host 的 `clearError` 外部接口经 command 排队、返回 Promise，不能直接接入。
  Host 装配前应先确定内存清理与排队落盘的边界，并提出方案；不能形成 command 嵌套重入，
  也不能给不等待回调的恢复工厂返回 Promise。
- 恢复与普通发送应共用互斥域；`withSessionLock` 不能另建一个与发送无关的锁。
- Host 接入 `prepareModelWindowSwitch` 时，逐项对应它的结果。需要确认时沿用桌面对
  Device Link 的 `PRECONDITION_FAILED` 及原原因文本，保留原路线；不接受额外的
  `confirmedContextWindow` 字段，不自动确认。界面确认往返留在供应商与客户端视图阶段。
- 订阅换号的 retain-route 触发入口随账号分配接入；target 为空的显式伙伴重启随伙伴任务
  接入。共用工厂保留相应分支，不代表 Host 已开放这些入口。
- 先确定终态所有权，再接自动续跑；两处不能各自重试同一条输入。合成恢复消息也不构成
  新的用户授权。
