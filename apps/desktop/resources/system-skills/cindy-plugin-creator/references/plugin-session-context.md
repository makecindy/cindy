## 4.13 会话上下文(sessionContext 能力)

围着用户项目干活的插件(构建/检查/同步类)需要知道"现在是哪个会话、项目在哪个
文件夹"。声明 `"sessionContext": true` 后,agent 派活(tool-call)时主机把**宿主铸造**
的上下文注入 `args.session_context`:

```js
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'tool-call') return;
  const ctx = msg.args.session_context;
  // ctx = { session_id, workdir, workdir_is_local, workdir_is_read_only }
  if (ctx?.workdir_is_local && !ctx.workdir_is_read_only && ctx.workdir) {
    // 只有本地且非只读时才能把 workdir 交给 Node 侧修改
    await cindy.node.request({ method: 'project/build', params: { dir: ctx.workdir } });
  }
});
```

规则与红线:

- 注入只发生在**主机侧**:agent 或任何上游自报的 `session_context` 一律被主机
  剥除后重铸——你拿到的字段永远可信,不需要再验;
- `workdir_is_local` 是安全核心:会话跑在 SSH 远程工作区(或主机证明不了是本地)
  时为 `false`,此时 `workdir` 是远端路径,**绝不能**当本机路径读写——同名本机
  目录可能存在,写下去就是事故;
- `workdir_is_read_only` 来自宿主对会话 permission / plan 状态的统一裁决;
  为 `true` 时只允许检查、列举等只读操作,不得初始化、构建或以其它方式修改 workdir;
- 这只是"位置信息",不是文件访问权:读写仍走 fs / node 各自的守门;
- 未声明本能力的插件,args 里永远没有 `session_context` 字段。
