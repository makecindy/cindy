# Mobile 任务消息内存治理架构

状态：实现说明（2026-08-15）

## 1. 模块职责

### `sessionRetention.ts`

唯一分类入口：`source === 'scheduler'` 返回 `schedule`，其余返回 `regular`。

### `sessionMessageLifecycle.ts`

纯状态 controller，负责：

- per-session generation 与 visible；
- authority 捕获和提交校验；
- 本地工作租约；
- 跨页面卸载存活的 pending reclaim；
- microtask 重试与重新聚焦取消。

它不导入 Store，不执行具体清理。`remoteSessionStore` 注册唯一 reclaimer，避免循环依赖
和页面各自实现回收状态机。

### `remoteSessionStore.ts`

负责：

- authority-aware 的消息写入口；
- schedule 写围栏和单窗裁剪；
- regular 压窗、保护判定与全局 LRU；
- 轻量运行时投影的 schedule 回收；
- 显式缓存删除语义；
- source 晚到后的策略迁移。

### `mobileSessionMessageCache.ts`

负责缓存 key、内容净化、保护行归一化，以及同 key 写删串行。

### `app/sessions/[sessionId].tsx`

只报告：

- 导航 focus/blur；
- AppState active/background；
- 页面聚合本地工作是否存在；
- `send()` 与 outbox dispatch 各自独立、跨卸载存活的工作租约。

页面发起的异步消息读取捕获 authority，并把它传给 Store 提交入口。device-link 重连补读
另保留从未打开 regular 的全局镜像路径，但提交时必须再次确认任务仍从未进入详情、且仍
归属请求发起设备；一旦进入过详情，就只能走 authority 路径。

## 2. 时序

### 2.1 正常打开

```text
focus + App active
  -> enter(sessionId)
  -> generation += 1, visible = true
  -> cache hydrate（regular only，提交前校验 authority）
  -> listMessages（捕获同一 authority）
  -> Store 写入并应用窗口/预算
```

### 2.2 失焦后快速返回

```text
A1 listMessages in flight
  -> blur: leave(A1), generation += 1, visible = false
  -> focus: enter(A2), generation += 1, visible = true
  -> A1 response arrives: generation mismatch, reject
  -> A2 response arrives: commit
```

旧 cleanup 同样携带 A1，晚到时无法撤销 A2。

### 2.3 有本地工作的离场

```text
leave -> revoke authority immediately
      -> local work active: record pending reclaim
page unmount / async finally -> last lease release
      -> microtask retry
      -> generation still inactive: Store reclaims
```

microtask 让同一轮 React cleanup 中的 outbox 恢复草稿、上传取消等步骤先完成。

### 2.4 source 晚到

```text
unknown source => regular (conservative)
fresh session metadata arrives with source=scheduler
  -> cache clear queued after older writes
  -> visible: clamp to one window
  -> hidden: request reclaim
  -> pending hydrate/timer commit rechecks retention and rejects
```

## 3. 关键不变量

1. authority 只能单调失效，不能通过 sessionId “摆回来”恢复有效。
2. leave 先撤权，后判断能否做破坏性回收。
3. deferred reclaim 的所有者是常驻 controller，不是页面 effect。
4. `messages.length === 0` 不是磁盘删除指令。
5. schedule 不读取或持久化长期完整消息缓存。
6. regular LRU 只淘汰内存，不碰磁盘窗口。
7. 本地系统卡没有服务端副本，所有压窗与缓存归一化必须保护。
8. 当前详情保护对 regular 与 schedule 一致；回前台必须重新 enter。
9. status、通知摘要与 live activity 不依赖完整消息驻留。
10. source 缺失时只能保守按 regular，不能用标题或索引猜测。
11. 页面聚合租约结束不代表异步发送结束；send/outbox 独立租约只能由自己的 `finally` 释放。
12. regular 离场与 LRU 都必须释放详情投影并抬升 projection epoch。
13. 含不可重取消息行的 regular 窗口不能参与整窗 LRU 淘汰。
14. 从未打开 regular 的重连补读只有在生命周期与设备归属都未变化时才能更新全局镜像。
15. 登出全清开始后到 `multiRemove` 完成前不能创建新的缓存写 authority。

## 4. 故障半径三问

### 断在哪里？

- 导航失焦；
- App 进入后台；
- device-link session topic 取消或断线；
- 页面原地切换 sessionId。

### 谁负责恢复？

- focus/AppState active 重新生成 authority；
- 页面触发一次 `load()`；
- device-link 对已进入详情的任务携带请求开始时 authority；从未打开的 regular 仅在响应
  返回时仍未进入且设备归属未变时更新全局镜像；
- regular 可先从磁盘窗口乐观恢复，schedule 直接从工作设备读取。

### 恢复前允许展示什么？

- regular 可展示仍在内存或合法 hydrate 的最新缓存窗口；
- schedule 回收后展示加载态/空窗，直到新代际读取完成；
- 不允许旧代际响应、旧订阅 push 或旧流式批次填回正文。

## 5. 交付检查清单

- [x] 分类只看 source。
- [x] per-session generation authority。
- [x] focus、AppState 与 session switch 接线。
- [x] 常驻工作租约与卸载后补回收。
- [x] async send 与 outbox dispatch 独立租约。
- [x] schedule 单窗、隐藏后归零、禁用加载更早。
- [x] regular 80 条压窗与 800 条 / 64 MiB LRU。
- [x] 草稿、运行、交互、pending queue、本地工作保护。
- [x] regular 离场/LRU 释放详情投影并抬升 projection epoch。
- [x] LRU 跳过含不可重取消息行的任务。
- [x] 缓存语义与内存淘汰解耦。
- [x] 本地系统卡保护。
- [x] authority、Store、缓存自动化测试。
- [x] Mobile 全量单测、scope guard、smoke、related unit 与 typecheck。
- [ ] iOS 模拟器：regular/schedule 前后台与快速切换目检。
- [ ] Android 模拟器：regular/schedule 前后台与快速切换目检。
- [ ] 长会话连续滚动、加载更早与内存曲线实机观察。

未完成的模拟器项目不应伪装成已验证；PR 描述需明确列出。
