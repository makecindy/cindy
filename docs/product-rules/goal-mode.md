# 目标模式与补充消息

> 权威产品规则。适用于目标运行期间的消息调度、停止和手机 `/goal` 入口。

目标运行期间，普通补充、问进度、排队消息与同轮插话优先处理，结束后继续原目标。
普通消息保留真实来源，不计入 Goal 轮数和预算，也不采用其正文作为 Goal 完成裁决。
显式暂停、Stop、清除仍优先于自动恢复与迟到事件；错误、限额和既有预算守卫不变。
待处理输入、审批、恢复暂停与队列锁未释放时，Goal 不抢跑；后台事件不视为新的目标轮次。
不通过关键词或额外模型调用推断自然语言暂停，现有明确控制入口才提供确定的暂停保证。

手机新建和已有任务中的 `/goal` 复用既有目标面板和 `maker:goal:*` 接口：无参数打开面板，
目标参数设置目标，`clear / stop / off / cancel / reset / none` 与桌面一样清除。
同名 Skill 优先；命令与附件组合明确拒绝并保留草稿。能力不支持或连接失败不降为模型消息，
已创建任务的 Goal 设置失败转到该任务恢复目标，不重复建任务或自动重放设置请求。

实现与回归：Desktop `goal-host/controller.ts`、`goal-host/__tests__/controller.test.ts`，
Mobile `session/desktopSlashCommands.ts`、`__tests__/mobileGoalCommands.test.ts`。
后台工作与目标的全面联动沿现有执行边界，不在此规则中引入额外生命周期或完成复核。

用量耗尽后的等待与续跑见[账号用量上限](usage-limit-auto-continue.md)。
