# #7259 快照整体预算与降级验收

范围：发送前与轮末快照的整体预算、Git 取消、失败后的回退缺口证据。远端关闭竞态 / Windows
`EBUSY` 恢复、流式解析和超限冷却不在本次实现范围内。

## 本轮 review

2026-10-26 复查当前工作区改动，未发现新的确定性 P0 / P1。重点检查：

- 预算包括意图落盘、目录探测、排队、过滤、暂存、标签和 ref 发布，阶段之间不重置。
- 发送 reservation 的取消信号贯穿准备阶段，最终派发前仍检查取消；排队过期不能迟到执行。
- Git 清理完成之前不放行同仓库写队列；无法确认清理时隔离受影响仓库，不重建设备连接。
- 每次执行有独立持久标识，旧成功不能覆盖同一消息的新失败；重读记录后仍保守降级。
- 自动保存使用临时 index 和隐藏 ref，不修改用户 HEAD、分支、暂存区。

保留的边界：原生文件系统请求不能强杀，只停止等待并拦截后续动作；意图记录本身写入失败
会拒绝派发，记录成功后的 Git 失败才继续发送。记录读取超时、损坏或超过 10000 条时仅回退
消息。文件 flush / 重建 store 的验证不等于掉电恢复验证。

## 可重复运行的本机验收

根目录执行（需要已有开发依赖和 Git）：

```sh
pnpm --dir apps/desktop exec vite-node --config vitest.config.ts scripts/snapshot-budget-acceptance.ts --files=10000
pnpm --dir apps/desktop exec vite-node --config vitest.config.ts scripts/snapshot-budget-acceptance.ts --files=100000
pnpm --dir apps/desktop exec vite-node --config vitest.config.ts scripts/snapshot-budget-acceptance.ts --files=1000000
```

脚本调用真实 coordinator、目录探测、快照内核、意图记录、Git 子进程和回退规划入口。
Electron 使用现有测试 stub，标签使用固定结果；不启动应用、不调用模型、不使用账号。
这验证快照准备链路，不代表完成了真实 UI / provider / device-link 端到端验收。

所有数据位于 `os.tmpdir()` 下唯一目录，默认自动清理；百万文件的创建和删除可能需要数分钟。
加 `--keep` 会打印并保留临时目录，用于下节实机操作。只在确认打印出的路径是此次唯一临时
目录后清理，不能对正式工作目录或账号目录执行删除。

通过条件：

1. 大仓库快照正常完成或降级返回：8 秒工作预算 + 最多 3 秒 Git 清理，脚本断言另容许
   1 秒计时 / 调度余量。统计从 `onTurnStart` 调用到返回，不包含造数据和模型响应。
2. 同时运行的小仓库成功生成基线，且不等大仓库预算耗尽。
3. 大仓库的 HEAD、用户 index 字节哈希和已有 seed 文件内容不变。
4. 同消息成功后再写入一个没有 Git 完成证据的执行意图；重建 store 后规划为
   `conversation-only`，不能误用旧成功。此项模拟的是持久层重新读取，不是完整应用重启。
5. 对真实等待 stdin 的 `git hash-object --stdin` 发取消，返回时 PID 已消失。

### Windows 本轮结果

环境：XD-PC，Node v24.14.1；每档一次，非统计意义的 p95。

| 未跟踪文件数 | 大仓库准备 | 并发小仓库 | 大仓库结果 | 真实 Git 取消清理 |
| --- | --- | --- | --- | --- |
| 10000 | 5426 ms | 365 ms | 基线成功 | 1350 ms |
| 100000 | 8001 ms | 388 ms | 超时降级，无基线 | 1279 ms |
| 1000000 | 2367 ms | 388 ms | 提前降级，无基线 | 1301 ms |

三档均通过 HEAD / index / seed 保持、持久记录重读后缺口识别和真实 PID 退出断言。
百万档造数耗时 214.18 秒，不计入快照预算；提前降级不能解读为扫描吞吐提升。该次输出只保留
了警告名称，没有错误细节，不能单凭耗时判定具体在哪个阶段失败。脚本现已同时输出错误原因。

## 自动回归

本轮已执行：

- Desktop 9 个定向文件：1088 条通过，18.01 秒；覆盖 coordinator、host、planner、rewind、
  makerSendTransaction、AgentInputCoordinator、gitExec、detectCwd、worktree 创建。
- 真实 Git 4 个文件：66 条通过、2 条既有能力跳过，32.92 秒；覆盖 shadow 保存点、过滤、
  bootstrap、旧保存点内核。
- maker-core reservation / close / origin：148 条通过；取消后无迟到 provider 派发。
- Desktop 类型检查通过；测试卫生、开发文档合同通过。

关键回归可单独复跑：

```sh
pnpm --dir apps/desktop exec vitest run src/main/__tests__/gitSnapshotCoordinator.test.ts src/main/__tests__/gitSnapshotHost.test.ts src/main/__tests__/codexFileRewindPlanner.test.ts src/main/maker-ipc/__tests__/makerSendTransaction.test.ts src/main/worktree/__tests__/gitExec.test.ts --maxWorkers=2
pnpm --dir apps/desktop exec vitest run --project=git-integration src/main/__tests__/gitSnapshotShadow.git-integration.test.ts --maxWorkers=1
pnpm --dir packages/maker-core exec vitest run src/session-control.test.ts src/session.close.test.ts src/session.origin.test.ts --maxWorkers=2
```

意图写入失败 / 挂起、探测 / bootstrap / 排队 / label 卡住、停止 / 关闭、无法确认树清理等
故障使用依赖注入和虚拟时钟覆盖。不要为验收去塞满系统盘、破坏真实账号记录或杀正式进程。

## 尚需实机验收

使用[隔离 Desktop](../dev-rules/desktop-development.md)，从本 worktree 启动：

```sh
pnpm restart:desktop:remote -- --isolated=@worktree
```

必须看到 `DESKTOP_DEV_VERDICT=ready`，登录测试账号并开启自动快照；`--mock` 不能代替真实
发送验收。不要重启承载当前会话的正式 Cindy。手机与第二台 Desktop 都连接这个隔离实例。

先运行造数脚本并加 `--keep`，把打印目录中的 `large` / `small` 作为两个测试任务的工作目录。
只操作测试文件；用 Codex / Pi 或明确走保存点回退链的运行方式。

| 场景 | 操作 | 验收判据 |
| --- | --- | --- |
| 超时后继续发送 | 手机向大仓库任务发送一次“只回复 OK” | 只有一次派发；快照准备不无限等待；区分快照耗时、网络耗时和模型首字耗时 |
| Stop 不迟到 | 在大仓库准备期间点停止，等待超过 11 秒后再看 | 没有迟到模型回复或重复执行；再发送新消息能继续 |
| 关闭不迟到 | 准备期间关闭测试任务，再重新打开 | 旧准备工作不会补发；新发送独立执行 |
| 多任务与多设备 | 大仓库准备时，另一 Desktop 向小仓库任务发消息；手机切换任务 | 小仓库能正常回复；两个控制端没有被整体断开或要求重连 |
| 同消息失败重试 + 重启 | 小仓库先成功执行一次；将保留 fixture 的 `large/bulk` 移入测试用 `small`，对原消息重试；出现快照降级后重启隔离实例并尝试回退 | 涉及失败执行的范围只能回退消息，文件保持；不能被第一次成功快照掩盖 |
| 正常回退仍可用 | 独立的小仓库任务让模型修改一个测试文件，完成后回退 | 文件恢复正确；不能把所有回退都降级来“通过”异常用例 |

记录每次 clientId / 任务、操作时间、准备与派发次数、界面结果和日志；同一设备内用单调时钟
比较耗时，不相减跨设备墙钟。Stop 场景若已进入 provider 执行，不能当作“发送前取消”证据，
需要重做并确认停在快照准备阶段。

以上完整 UI、手机 + 第二控制端、完整应用重启及 macOS 真实进程清理本轮未验证。
建议作为合并前实机验收项；自动化和 Windows 内核测试通过不能替代这些结论。
