## 4.14 目录选择(pick 能力)

需要用户交一个文件夹进来(导入/同步/部署源)时,声明 `"pick": true`,经管子请主机
弹**系统级**选文件夹窗口——用户亲手选中即授权,取消则你什么都拿不到:

```js
const picked = await cindy.pick({
  mode: 'directory',
  title: '选择要同步的项目父目录',   // 净化后随插件名一起展示(≤80 字)
  deposit: true,                      // 需要过户票据(上传用)时带;声明了 node 可省
  callId: msg.callId                   // 在工具处理函数里显式绑定这次调用
});
if (picked.ok) {
  // picked.name        —— 所选目录名(展示用)
  // picked.path        —— 绝对路径,仅声明了 node 的插件有(交给 Node 侧干活)
  // picked.dir_deposit —— 过户票据(同 ghost_call dir 通道;deposit:true 才有)
}
```

规则与红线:

- 对话框由主机拼装并带你的插件名,`title` 只是用途说明片段,伪装不了主机文案;
- 同一插件两次请求最小间隔 3 秒、全局同时只有一个选择框(超了回 RATE_LIMITED /
  BUSY);用户取消回 CANCELLED——**尊重取消,不要循环重弹**,那是骚扰;
- 未声明 node 的插件必须 `deposit: true`(没有票据你什么都拿不到,请求会被拒);
  票据收集有上限(500 文件/单文件 50MB/总 500MB),超限会签发失败;
- `path` 只发给声明了 node 的插件:Node 侧本就有用户级本机权限,给路径不扩权,
  价值是把"用户选了哪个目录"这一事实可信地交过去;
- 用户每次亲选成功,主机自己也会记一笔「亲选目录台账」(每插件最近 8 条)——
  派活(§4.11.1)的 `workingDir` 转述只对台账里的目录放行。台账建立在真实
  点选上,你存在 /kv 里的路径不算数。

### 文件选择（交互页面能力版本起）

新增可选参数，不影响 `mode:'directory'`：

```js
const picked = await cindy.pick({
  mode: 'file', into: 'media', accept: ['image/*'], multiple: true,
  callId: msg.callId,
});
// 或 into:'library', path:'imports'（需声明 library；path 是库内目录）
// {ok:true, files:[{name,size,mimeType,ref,sha256?,deposit?,path?}]}
```

需要 `pick:true`。系统对话框带插件名，和选目录共用 3 秒间隔及 BUSY 规则；取消回
`CANCELLED`，不自动重弹。一次最多 32 个文件。`accept` 是扩展名或 MIME 数组，作为
选择提示；实际类型按字节识别，未知附件是 `application/octet-stream`。
`into:'media'` 只收图片、视频、音频和 glb，单件 50 MiB、插件寄存总额 1 GiB，和
`deposit_media` 共用账本。`into:'library'` 流式写入本插件 Library，单件上限 8 GiB，
仍受磁盘保留水位和库的原有规则约束。字节不经过页面或 main.js。
多选按顺序导入，遇到首个失败就停止：`ok:false` 可带已成功的 `files` 和
`failedFile:{index,name}`（零基下标）；请保留这些引用，只重试失败项和后续未处理项，
宿主不会自动删除已成功文件。取消或权限失效仍走原取消流程，不返回旧权限下的引用。

`deposit:true` 可额外签发文件过户票据（包括单文件），交给 `fetch.uploadDir` 使用；
其 50 MiB 单件、500 MiB 总量和 500 文件限额仍适用。文件模式有持久引用，不要求
非 Node 插件必须申请票据。只有声明 Node 的插件会额外得到本机 `path`，**不要把该
路径放进页面的工具结果**。宿主不给 View 注入本机路径。

新版参数在旧宿主上会返回结构化 `{ok:false,...}`，请检查 `ok` 并提示升级；最低版本
按页面能力的 `PLUGIN_UI_MIN_CINDY_VERSION` 打包下限声明，即 `0.1.122-beta`。
手机和远程查看端本期没有新的文件选择确认入口，请回到执行任务的电脑操作。

### 等待与取消（文件和目录共用）

在工具处理函数里，把收到的 `msg.callId` 原样传给 `pick`。宿主只接受同插件仍在途的
调用，在系统选择及导入期间保留调用，不再因为默认 330 秒到期而丢掉选择；总时限仍为
从该工具调用开始算的 30 分钟。结束选择和导入后收回保留。未带 `callId` 的旧调用
维持原行为，宿主不会猜测它属于哪次工具调用。

带 `callId` 的调用被取消或到期时，`pick` 立即返回 `CANCELLED`。**取消调用不会关闭
已经打开的系统面板**；面板实际关闭前，宿主仍保持 BUSY（频繁请求也可能触发限频）。
迟到的选择会被丢弃，不会导入文件、登记目录或签发票据。换账号、插件更新或停用后，
也不能继续交付旧选择。插件应检查 `ok`，取消后不要继续处理文件或自动重开面板。

插件虚拟服务的页面 `tools/call` 在宿主侧采用同样的 30 分钟上限；这不改变其它 MCP
服务。页面自己的 RPC 客户端也应显式设置足够的等待预算（例如官方 App SDK 的
`callServerTool(params, { timeout: 30 * 60_000 })`），并处理超时或取消的 Promise 拒绝。
不要假定进度通知一定会延长客户端的等待时间。
