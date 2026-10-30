# 任务体验回归入口

> 修改任务创建、发送、恢复、归档、权限或默认模型时，先从对应行找到现有测试。
> 代码位置和共用入口见[仓库地图](repo-map.md)，测试价值与分层遵循[工程约定](engineering-conventions.md#32-新增测试的价值门槛)。

这份索引保存已反复遇到的用户场景与验证入口，不另建状态机或测试运行器。修改共同入口时反查普通任务、伙伴、群、调度、本机和远程调用方；只检查本次行为影响的入口，保留产品明确要求的差异。

| 场景 | 要保住的行为 | 现有回归入口 |
| --- | --- | --- |
| 新任务创建中继续输入，创建或发送失败后回编辑 | 第一条消息立即出现；后续文字和附件留在草稿；取消、删除和迟到的回复不复活任务 | [newSessionCreation](../../apps/mobile/src/__tests__/newSessionCreation.test.ts)、[真实恢复 hook](../../apps/mobile/src/__tests__/useNewSessionDraftRecovery.test.tsx)、[创建草稿落盘](../../apps/mobile/src/__tests__/newSessionCreationPersistence.test.ts) |
| 断线时读历史，恢复连接后补齐 | 保留已显示的历史；遗漏 push 只标记需要补读；旧查询不能覆盖新的正文和删除状态 | [remoteSessionStore](../../apps/mobile/src/__tests__/remoteSessionStore.test.ts) 中 `requests history reconciliation after a dropped push without clearing cached messages` 与消息 authority 场景；[durableOutbox](../../apps/mobile/src/__tests__/durableOutbox.test.ts) 验证重复投递和账号归属 |
| 归档先收起，后台未成功时恢复 | 预览阶段只隐藏列表行，详情元数据与正文保留；结束旧预览不影响新操作，不复活已删除任务 | [remoteSessionStore](../../apps/mobile/src/__tests__/remoteSessionStore.test.ts) 的两个 `archive preview` 场景；覆盖 store 行为，实际错误提示与滑动动画还需页面验收 |
| 普通任务与伙伴运行中切换权限 | 以 Host 接受并持久化后的状态为准；失败不假报成功、不发旧状态回滚；确认规则共用 | [sessionPermissionPersistence](../../apps/desktop/src/main/maker-ipc/__tests__/sessionPermissionPersistence.test.ts)、[botPermissionSwitch](../../apps/desktop/src/renderer/features/bots/__tests__/botPermissionSwitch.test.ts)、[permissionMode](../../packages/maker-shared/src/__tests__/permissionMode.test.ts) |
| 重启后发现中断任务、运行中断后续跑 | 启动候选与运行期续跑分别验证；已结束、已清空、已删除等边界不能误续跑 | [sessionActiveTurn](../../apps/desktop/src/main/localDb/__tests__/sessionActiveTurn.test.ts)、[interruptedTurnAutoResume](../../apps/desktop/src/main/maker-ipc/__tests__/interruptedTurnAutoResume.test.ts) |
| 供应商与模型缓存先显示，更新不覆盖手选 | 初值来自现有默认与缓存；任务内手动选择后不被后台默认值重置；伙伴默认与新任务选择独立 | [newSessionHostDefaults](../../apps/mobile/src/__tests__/newSessionHostDefaults.test.tsx)、[newMakerDefaultTuple](../../apps/desktop/src/renderer/lib/__tests__/newMakerDefaultTuple.test.ts)、[botDefaultModelChain](../../apps/desktop/src/shared/__tests__/botDefaultModelChain.test.ts) |
| 新 worktree 没有个人开发配置 | Global/CN 实际打包不要求或带入私有 dev 配置；显式 dev 仍要求自己的配置 | [envBundleTransform](../../apps/mobile/src/__tests__/envBundleTransform.test.ts)，覆盖 Expo 转换、Metro 依赖收集和解析 |

## 按改动选测

在仓库根执行，默认使用既有相关选测：

```sh
pnpm test:unit:related
```

需要复现具体场景时，直接运行对应文件，不依靠提取源码片段来模拟页面。以下是手机创建／历史／归档的入口；可以按改动缩小到其中一两个文件：

```sh
pnpm --filter mobile exec vitest run src/__tests__/newSessionCreation.test.ts src/__tests__/useNewSessionDraftRecovery.test.tsx src/__tests__/newSessionCreationPersistence.test.ts src/__tests__/remoteSessionStore.test.ts src/__tests__/durableOutbox.test.ts
```

桌面权限入口示例：

```sh
pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/sessionPermissionPersistence.test.ts src/renderer/features/bots/__tests__/botPermissionSwitch.test.ts
```

移动端提取 hook 或修改参数类型后补 `pnpm --filter mobile typecheck`。测试移动到新模块时，应保留静态生产依赖，让关联选测能选中它；共享夹具用[现有 typed fixtures](../../apps/mobile/src/__tests__/fixtures/newSession.ts)，不再复制一整套页面变量。

## 页面验证记录

单测验证数据和控制流程；用户可见的乐观显示、滚动、导航、滑动和错误提示仍按对应 [Desktop](desktop-development.md)／[Mobile](mobile-development.md) 规则验收。记录实际工作区、commit、运行中的版本身份、操作、可见结果和截图／日志位置，避免“代码通过了”被误读成“这台设备上的页面已验证”。

遇到新的复现，优先补在表中已有行为测试里，并写出触发条件和用户结果；只有出现新的业务边界时再建模块。本文只链接测试，不复制测试断言，不维护通过次数或临时任务状态。
