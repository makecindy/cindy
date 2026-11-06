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

### 4.22.1 在手机上查看与操作设备画面(liveScreen 能力)

提供设备画面的插件(模拟器、真机镜像)可以让用户在手机上全屏查看并直接触控。声明
`"liveScreen": true` 且同时声明 `node` 后,用户从手机打开时,Cindy 主进程经远程桌面
直接调用 Node 工作进程的以下固定方法(不经过 main.js,也不出现在 Agent 工具里):

| 方法 | 参数 | 返回 |
|---|---|---|
| `liveScreen.list` | `{}` | `{ok, screens:[{id, name, platform, state, taskIds}]}` |
| `liveScreen.open` | `{id}` | `{ok, url, screen:{platform, width, height, cornerRadius, maxTouches, keyboard, buttons}}` |
| `liveScreen.input` | `{id, events}` | `{ok}` |
| `liveScreen.control` | `{id, fps?, keyframe?}` | `{ok}`,Cindy 约每 20 秒调用一次作保活 |
| `liveScreen.close` | `{id}` | `{ok}` |

所有方法都带 `params._locale`(`zh-CN` 或 `en`);失败返回 `{ok:false, errorCode, message}`,
`open` 的错误码限 `NOT_FOUND`、`NOT_RUNNING`、`DISABLED`、`UNSUPPORTED`。

- **list**:只列本插件自己的设备,不得启动设备或续期活动。`id` 为 `[A-Za-z0-9._:-]{1,128}`;
  `platform` 为 `ios | ipados | tvos | visionos | android`;`state` 为 `running | starting | off`,
  只有 `running` 会被打开;`taskIds` 是绑定此设备的任务,手机据此在对应任务页右上角显示入口。
- **open**:`url` 必须是 `http://127.0.0.1:<端口>/…`,路径带 32 字节随机令牌,只接受一次 GET,
  流结束或 `close` 后失效。宿主拒绝其它主机、协议、用户名或片段。
- **帧流**:响应体是连续的 `[u32 大端长度][消息]`,消息首字节为类型:`0x01` avcC、`0x02`
  关键帧、`0x03` 普通帧(H.264 AVCC)、`0x04` JPEG / `0x06` PNG(退回路径)、`0x10` UTF-8 JSON
  `{"type":"screen","width","height","rotation"}`(`rotation` 为显示时顺时针转几个直角)。
  首帧前先发 `0x10`,变化时再发;连接后先发关键帧;画面静止时不发;单条不超过 8 MB。
- **input**:`events` 最多 64 个,坐标都是摆正后画面上的 0..1 比例:
  `{kind:'touch', touches:[{id, x, y, phase}], edge?}`(列出全部触点,`phase` 为
  `began | moved | stationary | ended | cancelled`,`edge` 只在起手时出现)、
  `{kind:'press', button}`(descriptor 里的按键 id)、`{kind:'text', text}`、
  `{kind:'key', code, modifiers?}`、`{kind:'release'}`(抬起全部触点)。
- **descriptor**:`buttons` 不超过 16 个,`id` 为 `[a-z0-9-]{1,32}`,`icon` 取
  `home | back | recents | lock | power | volume-up | volume-down | rotate-left | rotate-right |
  menu | play-pause | siri | shake | screenshot`,`label` 按 `_locale` 本地化;按重要性排序,
  手机工具栏只放前三个,其余在设置面板里。
- 有打开的帧流即算有人在看;插件自己的运行开关关闭时应拒绝 `open` 并结束已有的流。
- 一台电脑同一时间只有一路远程连接:打开设备画面会替换当前的整屏远程桌面。手机上的
  配对、授权与「仅查看」沿用远程桌面;插件不需要、也拿不到手机或远程桌面的任何凭证。
- 旧版 Cindy 把 `liveScreen` 当作未知字段保留且不赋予能力,不需要提高 `minCindyVersion`;
  在支持的版本上,插件详情会把它列为一项能力。
