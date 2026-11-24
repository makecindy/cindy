# 远程新建目标任务的初始标题

手机新建目标任务时，在现有 `maker:goal:set` 请求上携带可选的
`persistInitialTitle: true`。被控端只在第一次保存目标文案成功后处理该标记，
使用既有的任务标题条件写入。已命名的任务和用户手动保存的标题优先。
标题写入失败时继续执行已保存的目标。客户端不重复提交目标或补发改名请求。

旧被控端忽略该字段，目标创建和手机本地标题预览继续按原流程运行。
旧客户端省略字段，新被控端保持原有标题流程。没有新增 channel、事件或中转字段，
本地和自建中转都继续转发现有业务请求与标题更新通知。

回归入口为 Desktop 的 `goal-host/__tests__/index.test.ts` 与 Mobile 的
`mobileGoalCommands.test.ts`。标题的 SQLite 条件写入及手动改名保护分别由
`sessionAutoTitlePersist.test.ts` 和 `sessionAutoTitle.test.ts` 覆盖。
