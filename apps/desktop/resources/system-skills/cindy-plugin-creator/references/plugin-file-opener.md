## 4.25 插件接管打开的文件类型(fileOpener)

插件能用本机应用打开某类文件(例如用自家办公软件打开 Word、Excel、PPT)时,声明
`fileOpener`。用户在 Cindy 里用系统默认应用打开本机文件时——预览里的「打开」、文件
卡片右键「用默认应用打开」、按住修饰键点击、文件浏览器里「在系统中打开」——Cindy 会先把
文件交给声明了该扩展名的插件,由插件打开;插件没打开就照常交给系统默认应用。

```json
"node": { "entry": "node/worker.cjs", "protocol": "json-rpc-stdio" },
"fileOpener": { "extensions": [".docx", ".xlsx", ".pptx"] }
```

- 只用于 `schemaVersion: 3`,必须同时声明 `node`:插件会拿到用户所开文件的完整路径,
  与 `pick` 一样只开放给有本机工作进程的插件。
- `extensions` 列 1–32 个小写扩展名,带点,不重复,如 `.docx`、`.tar.gz`。按文件名结尾匹配,
  不区分大小写。
- 安装确认与插件详情单列一条权限,逐项列出扩展名;更新时新增该能力或新增扩展名算权限
  变多,需要用户确认。确认后默认生效,用户可在插件详情「配置」区关掉,Cindy 不再把这些
  文件交给你。
- 不交给插件的情况:其它电脑上的文件(打开的是本机缓存副本,改了也回不到原电脑)、
  Cindy 媒体库里的文件、文件夹、右键「打开方式」里用户明确选的其它应用。插件停用、
  回执超时或回 `ok:false` 时,用系统默认应用打开。
- 多个插件声明了同一扩展名时,按已装插件列表顺序交给第一个可用的。

### 收到打开请求

用户打开命中的文件时,逻辑页(`main.js`)收到事件;没在运行的插件会先被唤醒:

```js
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'event' || msg.name !== 'open-file') return;
  // msg.requestId、msg.deadline(ms epoch)、msg.data.path(本机绝对路径)
  const r = await cindy.node.request({ method: 'open', params: { path: msg.data.path } });
  await cindy.send({ type: 'file-open-result', requestId: msg.requestId, ok: Boolean(r.ok && r.result?.opened) });
});
```

- 在 `deadline` 前回执(含唤醒插件的时间,共约 15 秒)。程序已经交给本机应用就可以回
  `ok:true`,不必等窗口画出。
- 不打算处理这个文件(例如本机应用没装)就回 `ok:false`,Cindy 立刻改用系统默认应用;
  不回执会让用户多等到超时。
- 回执只认收到请求的同一插件,`requestId` 过期或不匹配时被静默丢弃。
- 不要把路径写进日志或发到网络;只用它打开文件。

旧版 Cindy 不认识 `fileOpener`,会原样保留但不交文件给插件;插件的其它功能照常可用。
