## 4.22 跟对话的任务页(taskView 能力)

插件需要一个**跟着任务走**的页面时(每个任务各看各的:这个任务的模拟器、这个任务的
构建进度、这个任务的预览),声明 `taskView`:

```json
{
  "schemaVersion": 3,
  "minCindyVersion": "1.2.3",
  "taskView": { "title": "模拟器", "html": "task.html" }
}
```

- 页签存在**每个任务自己**的右侧栏里(与文件、终端同一组),切换任务时随任务切换;
  页签头由 Cindy 绘制,标题取 `taskView.title`(缺省插件 `name`),图标取插件图标,
  **没有地址栏**。用户可以拖到别的边、最大化、弹成独立窗口或关闭,与其它任务页签一致;
- 与之相对:`mainView` 与非 `tab` 的 `panel` 是**不跟对话**的全局页面(§4.20、§5)。
  两类可以同时声明——例如任务页显示本任务的内容,主视图做跨任务的总览与管理;
- `taskView.html` 必须是包内安全相对路径且文件真实存在;声明过基础 title 后,locale
  文件可用 `"taskView": { "title": "Simulator" }` 翻译;
- 页面经查询参数 `session` 得知自己所在的任务:
  `new URLSearchParams(location.search).get('session')`。按它区分各任务自己的状态;
- 打开或聚焦任务页由逻辑页发起(页面本身零桥):

  ```js
  const opened = await cindy.taskView({ sessionId: ctx?.session_id }); // 缺省落台前任务
  if (opened.ok) bindToTask(opened.sessionId);   // 回执带回实际落点任务
  else console.warn(opened.errorCode, opened.message);
  ```

  同一任务里每个插件至多一个任务页页签,重复打开即聚焦已有页签。它只承载你自己的
  包内页面、不接收网址,所以没有 preview 那样的白名单与限速。错误码:
  `PERMISSION_DENIED`(未声明 taskView 或未启用)/ `INVALID_REQUEST` /
  `HOST_NOT_READY`(当前没有任务,或没有宿主窗口);
- 用户点击主视图里的任务跳转按钮时，可调用 `cindy.taskView({ sessionId, focus: true })`：
  打开该任务的插件页签，并通过宿主既有任务导航切到该任务；已分离的侧栏也按主动打开处理。
  缺省或 `focus: false` 仍只开页签、不抢前台，后台工具调用不应传 `focus: true`。
  Host 须观察到该插件实例最近 3 秒内的真实鼠标/键盘点击，且一次手势只能消费一次
  （与派活共用）；无手势、已过期或已消费均回 `PERMISSION_DENIED`，不开页也不导航。
  成功回执额外带 `focusRequested: true`，表示导航请求已投递，不表示目标任务一定存在；
  不存在的任务沿用任务导航的错误处理。旧宿主可能忽略 `focus`，缺该回执字段时应提示更新，
  不能声称已跳转。`peek: true` 始终只查询，即使同时传 `focus: true` 也不导航。
- `cindy.taskView({ peek: true })` 只问"现在打开会落到哪个任务",不开页签:有台前任务
  回 `{ ok: true, sessionId }`,没有则 `HOST_NOT_READY`。用它决定自己的界面(如 mainView
  管理页)要不要出现"在当前任务中打开"一类入口——整页主视图里通常没有台前任务;
  台前任务会变,需要时重新问;
- 使用 `taskView` 的插件须将 `minCindyVersion` 设为实际支持并完成整包验收的宿主版本。
  旧宿主可能保留未知的顶层字段,但会拒绝 `locale.taskView` 或 v2 的 `task-view` 槽;
  仅判断 `typeof cindy.taskView === 'function'` 不能保证旧版可安装。确需兼容旧版时,
  必须验证整个包的声明与本地化均可安装,再以 preview(§4.15)作为运行时回退;
- 任务页与 panel / mainView 共用同一 Ghost WebView 沙箱:零 Node、零通用 preload、每插件
  专属 partition、CSP 与导航守门不变,本身不附赠联网、文件或凭证能力;通信、唤醒与
  主题规则同 §5;
- 远程任务(工作目录在另一台电脑)不显示本机插件的任务页;插件停用、卸载或不再声明
  taskView 时,已有任务页页签自动隐藏。
