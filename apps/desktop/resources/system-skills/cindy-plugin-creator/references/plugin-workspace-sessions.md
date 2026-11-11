## 4.17 创建工作区会话(workspace 能力)

需要把某个项目目录变成侧边栏里的会话入口("打开项目"/仓库列表这类场景)时,
声明 `"workspace": true`,经管子请主机**确保**该目录下存在一个会话:目录下已有
active 会话直接复用(created:false),没有才创建一个空会话,创建/命中后显示在
侧边栏对应工作区分组里。

面板里由用户点击发起(推荐,用户在系统窗口亲选目录即授权):

```js
const ensured = await cindy.workspace({
  kind: 'ensure-session',
  mode: 'pick',                    // 主机弹系统选文件夹窗口
  title: '选择要打开的项目目录',    // 用途说明(≤100 字),也用作新会话标题
  focus: true                      // 可选:创建/命中后跳转聚焦到该会话,缺省只落侧边栏
});
if (ensured.ok) {
  // ensured.sessionId —— 会话 id
  // ensured.created   —— true = 新建;false = 命中已有会话复用
  // ensured.name      —— 目录名(展示用;绝对路径不会给你)
}
```

处理 ghost_call 工具调用期间已经拿到目录路径时,可改用 dir 模式,带上本单 callId:

```js
// main.js 的 tool-call 处理器里(msg.callId 是主机随单下发的)
const ensured = await cindy.workspace({
  kind: 'ensure-session',
  mode: 'dir',
  dir: '/Users/me/projects/demo',  // 本机绝对路径
  callId: msg.callId               // 主机铸造的上下文凭证,只在本单在途期间有效
});
```

规则与红线:

- `mode:'pick'` 的授权动作是用户亲手选中,取消回 CANCELLED——**尊重取消,不要
  循环重弹**;绝对路径不回沙箱,你只拿到目录名与会话 id;
- `mode:'dir'` 只能在处理 ghost_call 期间用:callId 配对失败回 PERMISSION_DENIED;
  目录在发起会话的工作目录内自动放行,之外弹确认卡由用户决定(拒绝/超时回
  CANCELLED,不要重试,如确有需要先与用户沟通);目录必须真实存在
  (DIR_NOT_FOUND / NOT_DIRECTORY);
- 只支持本机目录,远程(SSH)工作区一律拒;
- 同一插件两次请求最小间隔 3 秒、全局同时只有一个窗口/确认卡在场(RATE_LIMITED /
  BUSY);
- 创建的是**空会话**:不拉起 agent、不发消息、不自动开始任何任务;要让 Agent
  立即干活请配合 agent 能力(§4.11)。
