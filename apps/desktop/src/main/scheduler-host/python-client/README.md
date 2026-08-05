# Cindy Desktop「仅运行脚本」Python 客户端

Cindy 自动化任务支持 **script 执行模式**:触发时不起 agent、零 token,宿主直接
spawn 你的脚本;脚本通过 stdin/stdout 的 JSONL 协议(`cindy-script/1`)回调
宿主的受限能力(Jira / 飞书 / 会话派发),能力按任务级白名单授予、默认全拒。

本目录与 Desktop 定时器的 `scheduler-host` 共置，是 Python 协议客户端的
**权威副本**，同时包含一份可执行的接入验收脚本：

| 文件 | 说明 |
|---|---|
| `protocol.py` | 协议层(JSONL 双工；含 stdout fd 接管与 UTF-8 兜底)，**不用改** |
| `maker_client.py` | 能力封装(`jira_*` / `feishu_*` / `sessions_dispatch` / 通用 `call_rpc`)，**不用改** |
| `demo.py` | 最小可执行接入脚本，拷走后修改业务逻辑 |

> 下游项目(如 proj-workflow 的 auto-jira-dispatch)按拷贝分发这两个客户端文件；
> 协议或能力面变更时以本目录为准同步。

## 快速开始

1. 把三个文件拷到你的项目里,改 `demo.py` 写业务;
2. Cindy 里「创建自动化」→ 执行方式切「**仅运行脚本**」→ 脚本命令填
   `python demo.py` → 选项目目录(= 脚本 cwd)→ 勾选需要的能力 → 定时或手动;
   也可以直接对 agent 说一句「建个自动化,每 5 分钟跑 python demo.py,给它读取
   飞书的权限」;
3. 点「立即运行」验证,结果文本显示在任务的运行历史里。

## 可用能力(默认全拒,按任务勾选)

| 能力 | 方法 | 说明 |
|---|---|---|
| (免授权) | `host_capabilities()` | 自省:返回本任务已授予的能力与完整方法目录,脚本先 list 再决定怎么 call |
| `jira.read` | `jira_issue_get(key, fields?)` / `jira_issues_search_jql(jql, fields, max_results, next_page_token?)` | 读 Jira(走已连接的 Atlassian 账号;**需要 XD Atlassian 意识装入且唤醒**) |
| `jira.comment` | `jira_issue_add_comment(key, body_text)` | 写 Jira 评论(同上) |
| `feishu.read` | `feishu_recent_chats(count≤50)` / `feishu_recent_messages(chat_id, count≤50, start_time?)` | 按活跃倒序列最近会话;拉指定会话最近消息(新→旧,含 sender_name,`start_time` 做增量游标)。走应用内飞书登录态,token 不下发脚本 |
| `sessions.dispatch` | `sessions_dispatch(message, title?, target_session_id?)` | 创建或唤醒 Cindy 会话并投递消息;新会话配置继承任务本身(agent/model/目录),脚本无法伪造 |

## 必须遵守的约定

- **stdout 只属于协议**:任何诊断输出走 stderr(宿主截留 64KB 进
  `apps/desktop/logs/main-*.log` 的 `[script-runner]` 条目)。`protocol.py` 会做
  fd 级接管兜底(脚本/三方库/子进程的杂音 print 都改道 stderr),但不要依赖它。
- **结果走 `emit_complete(result_text)`**:必须恰好发一次,exit code 必须为 0,
  否则整轮记 failed。
- **错误码是结构化的**:`MakerClientError.code` 可能是 `CAPABILITY_DENIED`(没勾
  能力)/ `METHOD_NOT_FOUND` / `INVALID_ARGS` / `HOST_NOT_READY` / `GHOST_ASLEEP`
  (意识沉睡)/ `AUTH_EXPIRED`(登录态过期)等,按需分支处理。
- **大结果集要分页**:宿主对单次响应有体积上限,`jira_issues_search_jql` 用
  `next_page_token` 翻页(参考 auto-jira-dispatch 的 `_search_all_issues`:
  截断时减半页重试)。
- 环境变量经过白名单过滤(PATH/HOME 等基础项保留,凭证类一律不透传);任务可配
  整轮超时,超时杀整棵进程树。

## 模式示例:bot 入口(扫"任意人发给我的新消息"→ 关键指令驱动)

飞书没有单一"收件箱"API,标准做法是两步轮询(定时任务每 1-5 分钟一轮):

```python
cursor = load_cursor()  # 本地文件存上次扫描时间与已处理 message_id
chats = maker_client.feishu_recent_chats(count=20)          # 最近活跃会话
for chat in chats.get("chats", chats.get("items", [])):
    msgs = maker_client.feishu_recent_messages(
        chat["chat_id"], count=20, start_time=cursor.time)   # 增量拉新
    for m in new_only(msgs, cursor):                         # 去重
        if "#maker" in text_of(m):                           # 关键指令
            maker_client.sessions_dispatch(message=build_task(m))
save_cursor(cursor)
```

注意 `ByActiveTimeDesc` 排序下翻页可能漏群(飞书官方语义),轮询场景每轮从第一页
重扫 + 本地游标去重即可覆盖。

## 协议帧规格(其它语言接入用;Python 直接用 `protocol.py`)

stdin/stdout 各一路 JSONL,每行一帧。新脚本的出站帧使用
`"protocol": "cindy-script/1"`。为让已部署的旧脚本仍能启动,host 的初始
`start` 帧暂时使用 `xdt-maker-script/1`;客户端首次回帧后,host 会按客户端选用的
协议返回后续 `call_result`。当前 host 会通过 `CINDY_SCRIPT_PROTOCOL=1` 环境标记
声明支持新名称;新版 Python 客户端据此发送新名称,连接只有旧标记的旧 host 时则
自动沿用旧名称。

```jsonc
// host → script(stdin)
{"protocol":"xdt-maker-script/1","type":"start","context":{"scheduleId":"...","scheduleName":"...","runId":"...","firedAt":1710000000000,"workingDir":"..."}}
{"protocol":"cindy-script/1","type":"call_result","id":"py-1","ok":true,"result":{...}}
{"protocol":"cindy-script/1","type":"call_result","id":"py-2","ok":false,"error":{"code":"CAPABILITY_DENIED","message":"..."}}

// script → host(stdout)
{"protocol":"cindy-script/1","type":"call","id":"py-1","method":"jira.get","params":{"issue_key":"DING-1"}}
{"protocol":"cindy-script/1","type":"complete","resultText":"处理了 3 条","primarySessionId":null}
```

约束:单帧 ≤256KB;并发 in-flight call ≤16(超发返回 `TOO_MANY_REQUESTS`);
`complete` 只能发一次;stdout 出现任何非协议内容整轮判协议违规。编码恒为 UTF-8
(两端均是;`protocol.py` 已处理 Windows 下的 locale 默认编码问题)。
