# #6508：工作台空态修正与 macOS 验证

验证日期：2026-10-21。分支：`fix/6508-workbench-empty`。
基线：`f25a95f3b289d74b6aa4f18c78f8e2693b1ba4c6`，检查时包含本次未提交的修复。

## 结论与范围

本次修正两个已由回归测试证明的问题：

1. 宿主运行体不存在、归属已过期或尚未就绪时，返回既有 `PRECONDITION_FAILED`，不再返回成功的空投影。
2. 已读到缓存结果后刷新失败时，保留任务行并显示读取失败，隐藏安静空态和扫描成功页脚；后续读取成功时恢复。

**尚未复现 #6508 所述的「正常打开为空、关闭时闪现内容、重开仍为空」。**
本次改动不能被视为已确认解决该闪现现象，也不构成关闭 issue 的依据。
[原报告及评论](https://github.com/makecindy/cindy/issues/6508)未确认关闭对象，未提供录屏；
Windows/CN 仅是提交时快照。Windows 验证本次明确跳过，未用平台标志模拟代替实机结果。

## macOS 实机

环境：macOS ARM64、Electron 42.11.12、Global、隔离 userData。通过仓库安全入口启动：

```sh
pnpm restart:desktop:remote --region=global --isolated=@worktree
```

启动返回 `DESKTOP_DEV_VERDICT=ready`，界面分支核对为 `fix/6508-workbench-empty@f25a95f`。
经真实 IPC 读取远程伙伴已有工作台，不发送消息、不响应权限、不修改任务。
从伙伴头部的「打开工作台」进入，分别关闭标签和收起侧栏，再从同一入口重开。
Light/Dark 打开及重开截图均已目检，均显示 2 条「在做」，文字及布局正常。

改前对照仅把 `BotWorkbench.tsx` 临时换成基线版本，其余本地代码及远端宿主不变；
不是完整旧版本重跑。对照结束后已还原修复文件并核对字节一致。

| 代码 | 主题 | 关闭操作 | 关闭前 → 重开后行数 | 采样帧数 | 空态帧数 |
| --- | --- | --- | --- | --- | --- |
| 改前渲染代码 | light | 关闭标签 | 2 → 2 | 59 | 0 |
| 改前渲染代码 | light | 收起 | 2 → 2 | 62 | 0 |
| 改前渲染代码 | dark | 关闭标签 | 2 → 2 | 58 | 0 |
| 改前渲染代码 | dark | 收起 | 2 → 2 | 62 | 0 |
| 本次修复 | light | 关闭标签 | 2 → 2 | 58 | 0 |
| 本次修复 | light | 收起 | 2 → 2 | 62 | 0 |
| 本次修复 | dark | 关闭标签 | 2 → 2 | 61 | 0 |
| 本次修复 | dark | 收起 | 2 → 2 | 61 | 0 |

每次关闭采集约 1 秒 `requestAnimationFrame` 数据，只记录相对时间、挂载状态、行数、
空态布尔值（修复后另含宽度）。共 483 帧未观察到空态；这不是屏幕录屏，不能据此断言
所有合成器帧均无闪烁。两种主题下，改前与改后都没有复现原报告。

其他入口与限制：

- 独立工作台窗口记录到 `useNavigate() may be used only in the context of a <Router> component.`，
  与 [#6487](https://github.com/makecindy/cindy/pull/6487) 描述一致；后续截图为加载遮罩。
  此错误未混同为 #6508 的空态闪现，也未纳入本次修复。
- 调用 macOS 原生关闭自身入口并尝试激活后，未捕获显隐事件，不能计为有效的主窗口关闭/重开验证。
- 未验证 Windows、CN 或原报告者环境；未建立宿主未就绪与关闭闪现的因果关系。

## 双主题组件检查

在隔离 Electron 中加载真实 `BotWorkbench`、读取 hook、样式和主题，模拟宿主 API 数据。
加载、真空态、初次失败、缓存空结果后失败、缓存非空结果后失败、正常内容，
Light/Dark 共 12 个组合通过通用 UI 检查。

首次缓存空结果失败场景截得过早，不能作为失败终态证据。修正临时场景的事件时序后，
两个缓存失败场景的 4 个组合重跑通过并重新目检：失败提示可见、旧任务行保留、
安静空态与成功页脚隐藏。此检查未替换产品模块，但使用了模拟宿主数据，不能替代实机复现。

原始截图、帧记录与临时场景保存在验证 worktree 的 Git 忽略目录
`artifacts/issue-6508-real/`、`artifacts/ui-check/`、`tmp/6508-workbench.tsx`，
未随本次提交发布。此文保存可独立阅读的结果及限制，自动回归随源码提交。

## 回归与静态检查

先补回归、再修复：初始两个测试文件 **5 失败 / 13 通过**；生产代码修正后 **18 通过**。
新增测试覆盖运行体缺失/过期/未就绪、真实空结果、缓存刷新失败与恢复、
加载/失败区分、卸载重开，以及较早空响应不得覆盖较新非空响应。

扩展验证 **7 个文件、80 项测试通过**：

```sh
pnpm --filter desktop exec vitest run \
  src/main/bot-autonomy/__tests__/hub.test.ts \
  src/main/bot-autonomy/__tests__/runtime.test.ts \
  src/main/bot-autonomy/__tests__/taskWatch.test.ts \
  src/main/bot-autonomy/__tests__/autonomyRules.test.ts \
  src/renderer/features/bots/__tests__/BotWorkbenchView.test.tsx \
  src/renderer/features/bots/__tests__/botWorkbenchLifecycle.test.tsx \
  src/renderer/features/right-sidebar/lib/__tests__/openBotWorkbenchTab.test.ts \
  --maxWorkers=2
pnpm --filter desktop run --if-present typecheck
pnpm check:dev-docs
git diff --check
```

Desktop 类型检查、文档检查及 diff 空白检查通过。首次类型检查因 Mobile 工作区依赖未安装失败，
补齐依赖后重跑通过；没有通过修改源码或弱化检查消除该环境错误。没有执行完整仓库测试或远端 CI。

## 同步主干后的补充验证

2026-10-21 同步 `origin/main@fc15f8464a`（含 #6675），保留远程状态按需刷新、
立即返回缓存投影与账号切换校验，同时保留本 PR 的宿主就绪检查。
冲突仅涉及 `hub.ts` 与对应测试；补充断言未就绪时不触发远程刷新。
上述同一组定向命令重跑：**7 个文件、94 项测试通过**（Vitest 总耗时 3.26 秒）；
Desktop 类型检查、文档检查（10 项）与 diff 空白检查均通过。

上文 macOS 实机与组件截图均为同步前的验证，未在同步后重新拍摄；
Windows 仍未验证，原始关闭闪现仍未复现。
