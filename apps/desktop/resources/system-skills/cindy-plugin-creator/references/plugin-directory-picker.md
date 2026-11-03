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

### 文件选择

```js
const picked = await cindy.pick({
  mode: 'file', into: 'library', path: 'imports',
  accept: ['.csv', '.xlsx'], multiple: true, callId: msg.callId
});
// {ok:true,files:[{name,size,mimeType,ref,sha256?,deposit?,path?}]}
```

需要 pick:true；into:'library' 还需 library:true。图片、音视频和 glb 也可用 into:'media'。
accept 是扩展名或 MIME 数组，作为选择提示；不要拿它代替业务类型校验。一次最多
32 个文件。取消返回 CANCELLED，对话框忙时返回 BUSY；不要自动重弹。
多选失败可能附上已成功的 files 和 failedFile，保留成功引用并说明未完成项。

媒体单件 50 MiB、寄存总额 1 GiB；Library 单件 8 GiB，仍受磁盘空间约束。
deposit:true 可申请 uploadDir 所需的一次性交接信息，沿用其上传限额。
不要把返回的本机 path 交给页面，页面使用 ref。最低 Cindy 版本为 0.1.122-beta；
手机和远程端不可假定支持执行电脑的文件选择，应提示回执行电脑操作。

在工具处理函数里带 msg.callId，等待预算最长 30 分钟。取消后不要继续处理文件；
取消调用不会关闭已经打开的系统选择框，关闭前仍可能 BUSY。
页面调用方法和等待设置见[§4.23](plugin-interactive-pages.md)。
